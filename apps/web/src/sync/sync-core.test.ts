import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyCommand, loadSceneText, makeEnvelope, serializeScene } from '@flat/scene';
import type { Command, CommandEnvelope, Scene } from '@flat/scene';
import { SyncCore } from './sync-core';
import type { AppliedInput, CommandOutcome, SyncNotice } from './sync-core';

const load = (name: string): Scene => {
  const r = loadSceneText(readFileSync(new URL(`../../../../packages/scene/fixtures/${name}.flat.json`, import.meta.url), 'utf8'));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.scene;
};
const SAMPLE = load('sample');
const ser = serializeScene;

/** In-memory stand-in for apps/server: ordered log, idempotent by id, broadcast to every client. */
class FakeServer {
  epoch = 'E1';
  scene: Scene = SAMPLE;
  rev = 0;
  log: AppliedInput[] = [];
  private seen = new Map<string, CommandOutcome>();
  clients: Client[] = [];

  post(env: CommandEnvelope, from: Client | null): void {
    let outcome = this.seen.get(env.id);
    if (!outcome) {
      const r = applyCommand(this.scene, env, { rev: this.rev });
      if (!r.ok) outcome = { kind: 'rejected', errors: r.errors };
      else if (r.noop) outcome = { kind: 'ok', noop: true };
      else {
        this.scene = r.scene;
        this.rev++;
        const entry: AppliedInput = { epoch: this.epoch, seq: this.rev, rev: this.rev, envelope: env };
        this.log.push(entry);
        for (const c of this.clients) c.ws.push(entry);
        outcome = { kind: 'ok', noop: false };
      }
      this.seen.set(env.id, outcome);
    }
    from?.http.push({ id: env.id, outcome });
  }

  hello() {
    return { epoch: this.epoch, rev: this.rev, scene: this.scene };
  }
}

class Client {
  ws: AppliedInput[] = [];
  http: { id: string; outcome: CommandOutcome }[] = [];
  outbox: CommandEnvelope[] = [];
  tasks: (() => void)[] = [];
  notices: SyncNotice[] = [];
  shown: Scene | null = null;
  core: SyncCore;
  n = 0;

  constructor(
    readonly server: FakeServer,
    readonly name: string,
  ) {
    this.core = new SyncCore({
      send: (e) => this.outbox.push(e),
      display: (scene) => {
        this.shown = scene;
      },
      notice: (n) => this.notices.push(n),
      needCatchUp: (since) =>
        this.tasks.push(() =>
          this.core.onLog({ epoch: server.epoch, rev: server.rev, entries: server.log.filter((e) => e.seq > since), truncated: false }),
        ),
      needSnapshot: () => this.tasks.push(() => this.core.onSnapshot(server.hello())),
    });
    server.clients.push(this);
  }

  connect(): void {
    this.core.onHello(this.server.hello());
  }

  /** Applies a command like the store would (optimistically), then hands it to the core. */
  dispatch(cmd: Command): boolean {
    const base = this.core.display() ?? this.shown;
    if (!base) return false;
    const env = makeEnvelope(cmd, { id: `${this.name}-${this.n++}`, ts: this.n });
    const r = applyCommand(base, env);
    if (!r.ok) return false;
    this.shown = r.scene;
    this.core.local(env);
    return true;
  }

  disconnect(): void {
    this.ws = [];
    this.http = [];
    this.core.onDisconnect();
  }

  /** Delivers one message; false when nothing was waiting. */
  step(rng: () => number): boolean {
    const options: (() => void)[] = [];
    if (this.outbox.length) options.push(() => this.server.post(this.outbox.shift()!, this));
    if (this.ws.length) options.push(() => this.core.onApplied(this.ws.shift()!));
    if (this.http.length) options.push(() => {
      const h = this.http.shift()!;
      this.core.onResponse(h.id, h.outcome);
    });
    if (this.tasks.length) options.push(() => this.tasks.shift()!());
    if (!options.length) return false;
    options[Math.floor(rng() * options.length)]!();
    return true;
  }

  settled(): boolean {
    return !this.outbox.length && !this.ws.length && !this.http.length && !this.tasks.length;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOMS = SAMPLE.rooms.map((r) => r.id);
const LIGHTS = SAMPLE.lights.map((l) => l.id);
const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

function randomCommand(rng: () => number): Command {
  const one = (): Command => {
    switch (Math.floor(rng() * 7)) {
      case 0:
        return { type: 'room.setFloor', roomId: pick(rng, ROOMS), materialId: pick(rng, ['floor-oak', 'floor-tile', null]) };
      case 1:
        return { type: 'room.setCeiling', roomId: pick(rng, ROOMS), materialId: pick(rng, ['ceiling-white', null]) };
      case 2:
        return { type: 'scene.setDefaults', wall: pick(rng, ['paint-white', 'paint-sage']) };
      case 3:
        return { type: 'site.set', site: { northAngle: Math.floor(rng() * 360) } };
      case 4:
        return { type: 'light.update', id: pick(rng, LIGHTS), patch: { on: rng() < 0.5 } };
      case 5:
        return { type: 'light.remove', id: pick(rng, LIGHTS) };
      default:
        return { type: 'room.setWallFinish', roomId: pick(rng, ROOMS), materialId: pick(rng, ['paint-white', 'paint-sage']) };
    }
  };
  return rng() < 0.2 ? { type: 'batch', label: 'two', commands: [one(), one()] as never } : one();
}

describe('sync-core convergence', () => {
  it('random interleavings of local and remote commands converge to the server replay', { timeout: 60_000 }, () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = mulberry32(seed);
      const server = new FakeServer();
      const clients = ['a', 'b', 'c'].map((n) => new Client(server, n));
      clients.forEach((c) => c.connect());
      for (let i = 0; i < 120; i++) {
        const c = pick(rng, clients);
        const roll = rng();
        if (roll < 0.35) c.dispatch(randomCommand(rng));
        else if (roll < 0.4) {
          c.disconnect();
          c.connect();
        } else c.step(rng);
        // The shown scene always equals pending replayed over confirmed.
        for (const k of clients) if (k.shown) expect(ser(k.shown), `seed ${seed}`).toBe(ser(k.core.display()!));
      }
      for (let guard = 0; guard < 10_000 && !clients.every((c) => c.settled()); guard++) pick(rng, clients).step(rng);
      for (const c of clients) {
        expect(c.settled()).toBe(true);
        expect(c.core.pending, `seed ${seed} ${c.name}`).toEqual([]);
        expect(c.core.confirmedRev).toBe(server.rev);
        expect(ser(c.core.confirmed!), `seed ${seed} ${c.name}`).toBe(ser(server.scene));
        expect(ser(c.shown!)).toBe(ser(server.scene));
        expect(c.core.status).toBe('connected');
      }
    }
  });
});

describe('sync-core conflicts', () => {
  const setup = () => {
    const server = new FakeServer();
    const a = new Client(server, 'a');
    const b = new Client(server, 'b');
    a.connect();
    b.connect();
    const drain = () => {
      for (let i = 0; i < 100 && !(a.settled() && b.settled()); i++) {
        a.step(() => 0);
        b.step(() => 0);
      }
    };
    return { server, a, b, drain };
  };
  const floor = (s: Scene, id: string) => s.rooms.find((r) => r.id === id)!.floorMaterial;

  it('last writer wins: the server order decides, both clients end identical', () => {
    const { server, a, b, drain } = setup();
    a.dispatch({ type: 'room.setFloor', roomId: 'living', materialId: 'floor-oak' });
    b.dispatch({ type: 'room.setFloor', roomId: 'living', materialId: 'floor-tile' });
    // b reaches the server first, then a: a wins.
    b.step(() => 0);
    a.step(() => 0);
    drain();
    expect(floor(server.scene, 'living')).toBe('floor-oak');
    expect(floor(a.shown!, 'living')).toBe('floor-oak');
    expect(floor(b.shown!, 'living')).toBe('floor-oak');
    expect(a.notices).toEqual([]);
    expect(b.notices).toEqual([]);
  });

  it('a pending update whose target was deleted remotely is dropped and reported', () => {
    const { server, a, b, drain } = setup();
    a.dispatch({ type: 'light.remove', id: 'l-hall' });
    a.step(() => 0); // the server applies the removal
    b.dispatch({ type: 'light.update', id: 'l-hall', patch: { on: false } });
    expect(b.core.pending).toHaveLength(1);
    b.ws.forEach((m) => b.core.onApplied(m)); // the removal reaches b before its own update is answered
    b.ws = [];
    expect(b.core.pending).toHaveLength(0);
    expect(b.notices).toHaveLength(1);
    expect(b.notices[0]).toMatchObject({ kind: 'conflict', envelope: { cmd: { type: 'light.update' } } });
    expect(b.shown!.lights.some((l) => l.id === 'l-hall')).toBe(false);
    drain();
    expect(ser(b.shown!)).toBe(ser(server.scene));
  });

  it('a server refusal removes the pending command and shows the errors', () => {
    const { server, a, drain } = setup();
    a.dispatch({ type: 'light.update', id: 'l-hall', patch: { on: false } });
    server.scene = { ...server.scene, lights: server.scene.lights.filter((l) => l.id !== 'l-hall') }; // out-of-band change
    drain();
    expect(a.notices[0]).toMatchObject({ kind: 'rejected' });
    expect(a.core.pending).toHaveLength(0);
    // the optimistic change is rolled back to the confirmed state
    expect(a.shown!.lights.find((l) => l.id === 'l-hall')!.on).toBe(SAMPLE.lights.find((l) => l.id === 'l-hall')!.on);
  });

  it('a no-op answer clears the pending command without a new revision', () => {
    const { server, a, drain } = setup();
    a.dispatch({ type: 'room.setFloor', roomId: 'living', materialId: 'floor-oak' });
    drain();
    const rev = server.rev;
    a.dispatch({ type: 'room.setFloor', roomId: 'living', materialId: 'floor-oak' }); // locally a no-op too, but sent
    drain();
    expect(server.rev).toBe(rev);
    expect(a.core.pending).toEqual([]);
  });

  it('a gap in the stream triggers a catch-up from the log', () => {
    const { server, a, b, drain } = setup();
    b.dispatch({ type: 'site.set', site: { northAngle: 77 } });
    b.dispatch({ type: 'site.set', site: { northAngle: 78 } });
    b.step(() => 0);
    b.step(() => 0);
    a.ws.shift(); // the first broadcast is lost
    drain();
    expect(a.core.confirmedRev).toBe(2);
    expect(ser(a.shown!)).toBe(ser(server.scene));
  });

  it('reconnect on the same epoch catches up and re-sends pending (idempotent by id)', () => {
    const { server, a, b, drain } = setup();
    a.disconnect();
    expect(a.core.status).toBe('reconnecting');
    a.dispatch({ type: 'room.setFloor', roomId: 'bed1', materialId: 'floor-oak' });
    expect(a.outbox).toHaveLength(0); // offline: queued, not sent
    b.dispatch({ type: 'room.setFloor', roomId: 'bed2', materialId: 'floor-tile' });
    drain();
    a.connect();
    drain();
    expect(a.core.status).toBe('connected');
    expect(a.core.pending).toEqual([]);
    expect(ser(a.shown!)).toBe(ser(server.scene));
    expect(floor(server.scene, 'bed1')).toBe('floor-oak');
    expect(floor(server.scene, 'bed2')).toBe('floor-tile');
    // a second delivery of the same envelope changes nothing
    const rev = server.rev;
    server.post(a.core.confirmed ? makeEnvelope({ type: 'room.setFloor', roomId: 'bed1', materialId: 'floor-oak' }, { id: 'a-0', ts: 1 }) : ({} as never), null);
    expect(server.rev).toBe(rev);
  });
});

describe('sync-core epoch change', () => {
  const connected = () => {
    const server = new FakeServer();
    const a = new Client(server, 'a');
    a.connect();
    a.dispatch({ type: 'room.setFloor', roomId: 'living', materialId: 'floor-oak' });
    return { server, a };
  };
  const other = load('charme-3205');

  it('a hello with another epoch asks instead of overwriting', () => {
    const { a } = connected();
    const shownBefore = ser(a.shown!);
    a.core.onHello({ epoch: 'E2', rev: 0, scene: other });
    expect(a.core.status).toBe('conflict');
    expect(a.core.conflict).toMatchObject({ epoch: 'E2', pendingCount: 1 });
    expect(ser(a.shown!)).toBe(shownBefore); // untouched
    a.core.local(makeEnvelope({ type: 'site.set', site: { northAngle: 1 } }, { id: 'x', ts: 1 }));
    expect(a.outbox.filter((e) => e.id === 'x')).toHaveLength(0); // nothing is sent while undecided
  });

  it('"Use server scene" shows the server scene and reports the discarded edits', () => {
    const { a } = connected();
    a.core.onReset({ epoch: 'E2', rev: 3, scene: other });
    a.core.useServerScene();
    expect(a.core.status).toBe('connected');
    expect(a.core.epoch).toBe('E2');
    expect(a.core.confirmedRev).toBe(3);
    expect(a.core.pending).toEqual([]);
    expect(ser(a.shown!)).toBe(ser(other));
    expect(a.notices).toEqual([{ kind: 'discarded', count: 1 }]);
  });

  it('"Keep mine" uploads the displayed scene; the reset echo (before or after the answer) settles it', () => {
    for (const echoFirst of [true, false]) {
      const { a } = connected();
      const mine = ser(a.shown!);
      a.core.onHello({ epoch: 'E2', rev: 0, scene: other });
      const scene = a.core.beginOverwrite()!;
      expect(ser(scene)).toBe(mine);
      const echo = () => a.core.onReset({ epoch: 'E3', rev: 0, scene });
      const answer = () => a.core.finishOverwrite({ epoch: 'E3', rev: 0 });
      if (echoFirst) {
        echo();
        answer();
      } else {
        answer();
        echo();
      }
      expect(a.core.status).toBe('connected');
      expect(a.core.epoch).toBe('E3');
      expect(a.core.pending).toEqual([]);
      expect(ser(a.shown!)).toBe(mine);
    }
  });

  it('a reset that is not our own upload raises a new prompt while overwriting', () => {
    const { a } = connected();
    a.core.onHello({ epoch: 'E2', rev: 0, scene: other });
    a.core.beginOverwrite();
    a.core.onReset({ epoch: 'E9', rev: 0, scene: other });
    expect(a.core.status).toBe('conflict');
    expect(a.core.conflict!.epoch).toBe('E9');
  });
});
