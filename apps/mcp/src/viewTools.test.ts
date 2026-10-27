import { describe, expect, it } from 'vitest';
import { effectiveSessionLighting } from './tools/view';

import { connect, fakeClock, json } from './testing/inproc';
import { newSession } from './tools';
import { loadConfig } from './config';

const sun = (client: Awaited<ReturnType<typeof connect>>['client'], args: Record<string, unknown>) => client.callTool({ name: 'set_sun_time', arguments: args });

describe('set_sun_time (M4.11)', () => {
  it('stores date and time in the session and reports the sun', async () => {
    const { client } = await connect();
    const r = await sun(client, { date: '2026-12-21', time: '09:30' });
    expect(r.isError).toBeFalsy();
    const b = json(r);
    expect(b).toMatchObject({ ok: true, timezone: 'Europe/Paris', lighting: { date: '2026-12-21', time: '09:30', sunEnabled: true } });
    expect(b.utc).toBe('2026-12-21T08:30:00.000Z');
    expect(b.sun.isUp).toBe(true);
    // it is the session default for the next calls
    expect(json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'sejour' } })).daylight.date).toBe('2026-12-21');
    expect(json(await client.callTool({ name: 'get_scene_summary', arguments: {} })).lighting).toEqual({ date: '2026-12-21', time: '09:30' });
  });

  it('does not touch the flat or its history', async () => {
    const { client, flat } = await connect();
    await sun(client, { preset: 'evening' });
    expect(flat.rev).toBe(0);
    expect(flat.calls.filter((c) => ['postCommand', 'undo', 'redo', 'postView'].includes(c))).toEqual([]);
  });

  it('presets: evening is 20:00 on 21 December with the sun down; night disables the sun; day is noon', async () => {
    const { client } = await connect();
    const evening = json(await sun(client, { preset: 'evening' }));
    expect(evening.lighting).toMatchObject({ date: '2026-12-21', time: '20:00', sunEnabled: true });
    expect(evening.sun.isUp).toBe(false);
    expect(Object.keys(evening.lighting.lamps)).toHaveLength(9);
    expect(Object.values(evening.lighting.lamps).every((l) => (l as { on: boolean }).on)).toBe(true);
    const night = json(await sun(client, { preset: 'night' }));
    expect(night.lighting).toMatchObject({ time: '23:00', sunEnabled: false });
    const day = json(await sun(client, { preset: 'day' }));
    expect(day.lighting).toMatchObject({ time: '12:00', sunEnabled: true });
    expect(Object.values(day.lighting.lamps).every((l) => (l as { on: boolean }).on === false)).toBe(true);
  });

  describe('lamp mode (presets set a mode, light_update stays visible)', () => {
    const lampOf = async (client: Awaited<ReturnType<typeof connect>>['client'], id: string) => json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'sejour' } })).lights.find((l: { id: string }) => l.id === id);

    it('a preset sets the mode; lights added or updated afterwards follow it, and lumens/kelvin changes always show', async () => {
      const { client } = await connect();
      expect(json(await sun(client, { preset: 'evening' })).lampMode).toBe('allOn');
      await client.callTool({ name: 'light_update', arguments: { id: 'l-sejour', patch: { lumens: 321, kelvin: 2700 } } });
      expect(await lampOf(client, 'l-sejour')).toMatchObject({ on: true, lumens: 321, kelvin: 2700 });
      // a lamp added after the preset is lit too (the old per-lamp snapshot missed it)
      await client.callTool({ name: 'light_add', arguments: { light: { id: 'l-new', type: 'point', position: [2, 2], roomId: 'sejour', elevation: 2.4, lumens: 500, kelvin: 3000, on: false } } });
      expect(await lampOf(client, 'l-new')).toMatchObject({ on: true });
      const d = json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'sejour' } }));
      expect(d.lampMode).toBe('allOn');
      expect(d.note).toContain('lamps "scene"');
    });

    it('lamps: "scene" resets: the flat\'s own on/off shows again', async () => {
      const { client } = await connect();
      await sun(client, { preset: 'evening' });
      await client.callTool({ name: 'light_update', arguments: { id: 'l-sejour', patch: { on: false } } });
      expect(await lampOf(client, 'l-sejour')).toMatchObject({ on: true }); // hidden by the mode, and said so
      const r = json(await sun(client, { lamps: 'scene' }));
      expect(r).toMatchObject({ ok: true, lampMode: 'scene', lighting: { lamps: {} } });
      expect(await lampOf(client, 'l-sejour')).toMatchObject({ on: false });
      expect(json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'sejour' } })).lampMode).toBeUndefined();
      // day = allOff, and an explicit lamps wins over the preset's mode
      expect(json(await sun(client, { preset: 'day' })).lampMode).toBe('allOff');
      expect(json(await sun(client, { preset: 'day', lamps: 'allOn' })).lampMode).toBe('allOn');
      expect((await sun(client, { lamps: 'dim' })).isError).toBe(true);
    });

    it('effectiveSessionLighting (for the render service) applies the mode to the scene\'s current lights', async () => {
      const { flat } = await connect();
      const clock = fakeClock();
      const session = newSession(loadConfig({}, { log: () => {} }).limits, clock);
      const lights = flat.scene.lights;
      expect(effectiveSessionLighting(session, flat.scene).lamps).toEqual({});
      session.lampMode = 'allOn';
      const on = effectiveSessionLighting(session, flat.scene).lamps;
      expect(Object.keys(on).sort()).toEqual(lights.map((l) => l.id).sort());
      expect(Object.values(on).every((l) => l.on === true)).toBe(true);
      session.lampMode = 'allOff';
      expect(Object.values(effectiveSessionLighting(session, flat.scene).lamps).every((l) => l.on === false)).toBe(true);
    });
  });

  it('explicit date and time override the preset', async () => {
    const { client } = await connect();
    const r = json(await sun(client, { preset: 'evening', date: '2026-02-10', time: '18:15' }));
    expect(r.lighting).toMatchObject({ date: '2026-02-10', time: '18:15' });
  });

  it('keeps earlier settings when only one field is given', async () => {
    const { client } = await connect();
    await sun(client, { date: '2026-03-20', time: '10:00' });
    const r = json(await sun(client, { time: '16:00' }));
    expect(r.lighting).toMatchObject({ date: '2026-03-20', time: '16:00' });
  });

  it('rejects malformed and impossible values with a located error', async () => {
    const { client } = await connect();
    for (const [args, path] of [[{ date: '2026-02-30' }, 'date'], [{ date: '21/12/2026' }, 'date'], [{ time: '25:00' }, 'time'], [{ time: '9:30' }, 'time'], [{ preset: 'dusk' }, 'preset'], [{ bogus: 1 }, '']] as const) {
      const r = await sun(client, { ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(json(r).code).toBe('invalid_command');
      expect(json(r).errors[0].path).toBe(path);
    }
  });

  it('knows daylight saving in the site time zone (Europe/Paris)', async () => {
    const { client } = await connect();
    // 29 March 2026: 02:00 -> 03:00, so 02:30 does not exist
    const gap = await sun(client, { date: '2026-03-29', time: '02:30' });
    expect(gap.isError).toBe(true);
    expect(json(gap).message).toContain('03:30');
    // a failed call leaves the session as it was
    expect(json(await client.callTool({ name: 'get_scene_summary', arguments: {} })).lighting.date).toBe('2026-06-21');
    // 25 October 2026: 03:00 -> 02:00, so 02:30 happens twice; the earlier one (summer time) is used
    const overlap = json(await sun(client, { date: '2026-10-25', time: '02:30' }));
    expect(overlap.utc).toBe('2026-10-25T00:30:00.000Z');
    // the offset really differs across the change
    const before = json(await sun(client, { date: '2026-03-28', time: '12:00' }));
    const after = json(await sun(client, { date: '2026-03-30', time: '12:00' }));
    expect(before.utc).toBe('2026-03-28T11:00:00.000Z');
    expect(after.utc).toBe('2026-03-30T10:00:00.000Z');
  });

  it('syncs to the user tab only on request, with the client name', async () => {
    const { client, flat } = await connect();
    await sun(client, { time: '10:00' });
    expect(flat.views).toEqual([]);
    const r = json(await sun(client, { date: '2026-05-01', time: '11:00', sync_to_user_tab: true }));
    expect(r.syncedToUserTab).toEqual({ ok: true, delivered: 0 });
    expect(flat.views).toHaveLength(1);
    expect(flat.views[0]).toEqual({ from: 'unit-client', lighting: { date: '2026-05-01', time: '11:00' } });
    // sticky for the session until turned off
    await sun(client, { time: '12:00' });
    expect(flat.views).toHaveLength(2);
    await sun(client, { time: '13:00', sync_to_user_tab: false });
    expect(flat.views).toHaveLength(2);
  });

  it('relays only the keys the call set, never the defaults (a time-only sync is just {time})', async () => {
    const { client, flat } = await connect();
    await sun(client, { preset: 'evening' }); // lamps on, sun flags, date: all session state now
    await sun(client, { time: '18:30', sync_to_user_tab: true });
    expect(flat.views.at(-1)!.lighting).toEqual({ time: '18:30' });
    await sun(client, { date: '2026-04-01' });
    expect(flat.views.at(-1)!.lighting).toEqual({ date: '2026-04-01' });
    await sun(client, { date: '2026-04-02', time: '09:00' });
    expect(flat.views.at(-1)!.lighting).toEqual({ date: '2026-04-02', time: '09:00' });
    // the session itself keeps the evening lamps
    const s = json(await sun(client, { time: '19:00' }));
    expect(Object.values(s.lighting.lamps).every((l) => (l as { on: boolean }).on)).toBe(true);
    expect(Object.keys(flat.views.at(-1)!.lighting!)).toEqual(['time']);
  });

  it('a preset relays what the preset sets (time, sun switch, lamps) and nothing else', async () => {
    const { client, flat } = await connect();
    await sun(client, { preset: 'night', sync_to_user_tab: true });
    expect(Object.keys(flat.views.at(-1)!.lighting!).sort()).toEqual(['lamps', 'sunEnabled', 'time']);
    expect(flat.views.at(-1)!.lighting).not.toHaveProperty('exposureEV');
    expect(flat.views.at(-1)!.lighting).not.toHaveProperty('showContext');
  });

  it('a failing relay does not fail the call or lose the session setting', async () => {
    const { client, flat } = await connect();
    const gone = { ok: false as const, kind: 'http' as const, status: 404, errors: [{ code: 'internal_error', path: '', message: 'scene server answered 404' }] };
    const orig = flat.postView.bind(flat);
    flat.postView = async () => gone;
    const r = json(await sun(client, { time: '15:00', sync_to_user_tab: true }));
    expect(r.ok).toBe(true);
    expect(r.syncedToUserTab).toMatchObject({ ok: false, code: 'not_implemented' });
    expect(r.lighting.time).toBe('15:00');
    flat.postView = orig;
  });

  it('works while the server is read-only mode and is listed', async () => {
    const { client } = await connect({ readOnly: true });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('set_sun_time');
    expect(json(await sun(client, { preset: 'day' })).ok).toBe(true);
  });

  it('server_unreachable is a tool error', async () => {
    const { client, flat } = await connect();
    flat.down = true;
    expect(json(await sun(client, { time: '10:00' })).code).toBe('server_unreachable');
  });
});
