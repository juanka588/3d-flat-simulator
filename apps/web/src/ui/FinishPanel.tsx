import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { BUILTIN_MATERIALS, ceilingMaterial, floorMaterial, wallStats } from '@flat/scene';
import type { ApplyResult, Material, Scene, Sheen } from '@flat/scene';
import { useSceneStore } from '../state/sceneStore';
import type { Selection } from '../viewer/view-types';
import { ColorPicker } from './ColorPicker';
import { wallRoomsAt } from '../viewer/selection';
import { buildFinishCommand, materialLabel } from './finish-commands';
import type { FinishNames, FinishScope, FinishSource } from './finish-commands';
import { thumbUrl, useFinishCatalog } from './useFinishCatalog';

type ScopeKey = 'side' | 'both' | 'room' | 'floor' | 'ceiling' | 'zone';
interface ScopeOption {
  key: ScopeKey;
  label: string;
  scope: FinishScope;
}

const CATEGORY_LABELS: Record<string, string> = {
  'floor-wood': 'Wood floors',
  'floor-tile': 'Tile floors',
  'wall-plaster': 'Plaster walls',
  'wall-paper': 'Wallpaper',
  stone: 'Stone',
  outdoor: 'Outdoor',
};

/** Whether a selection can take a finish (wall sides, floors, ceilings). */
export function takesFinish(selection: Selection): boolean {
  if (selection.kind === 'floor' || selection.kind === 'ceiling') return true;
  return selection.kind === 'wall' && (selection.face === 'left' || selection.face === 'right');
}

/** Room that owns the longest stretch of a wall side, if any. */
function sideRoom(scene: Scene, wallId: string, side: 'left' | 'right'): string | undefined {
  const faces = wallStats(scene, wallId)?.faces[side] ?? [];
  let best: { roomId: string; len: number } | undefined;
  for (const f of faces) {
    if (!f.roomId) continue;
    const len = f.to - f.from;
    if (!best || len > best.len) best = { roomId: f.roomId, len };
  }
  return best?.roomId;
}

/** "Séjour / Cuisine" -> "Séjour": the first name of a combined room, for compact labels. */
function shortName(name: string): string {
  return name.split(' / ')[0]!.trim() || name;
}

/** Rooms on the clicked wall stretch: from the click point when known, else the room owning most of each side. */
function clickedRooms(scene: Scene, selection: Selection): { left?: string; right?: string } {
  if (selection.along !== undefined) return wallRoomsAt(scene, selection.entityId, selection.along);
  const left = sideRoom(scene, selection.entityId, 'left');
  const right = sideRoom(scene, selection.entityId, 'right');
  return { ...(left ? { left } : {}), ...(right ? { right } : {}) };
}

function scopeOptions(scene: Scene, selection: Selection): { options: ScopeOption[]; roomName?: string; names: FinishNames } {
  const names: FinishNames = {
    rooms: Object.fromEntries(scene.rooms.map((r) => [r.id, r.name])),
    zones: Object.fromEntries(scene.rooms.flatMap((r) => (r.floorZones ?? []).map((z) => [`${r.id}/${z.id}`, z.name ?? z.id]))),
  };
  if (selection.kind === 'wall' && (selection.face === 'left' || selection.face === 'right')) {
    const side = selection.face;
    const rooms = clickedRooms(scene, selection);
    // The click's own room wins (the face under the pointer); a face with no room here has none.
    const roomId = selection.roomId ?? rooms[side];
    const room = scene.rooms.find((r) => r.id === roomId);
    const wallId = selection.entityId;
    const options: ScopeOption[] = [
      {
        key: 'side',
        label: room ? `This wall (${shortName(room.name)} side)` : `This ${side} side`,
        scope: { kind: 'wallSide', wallId, side, ...(room ? { roomId: room.id } : {}) },
      },
      {
        key: 'both',
        label: 'Both faces here',
        scope: {
          kind: 'wallFaces',
          wallId,
          faces: (['left', 'right'] as const).map((f) => {
            const id = f === side ? room?.id : rooms[f];
            return id ? { side: f, roomId: id } : { side: f };
          }),
        },
      },
    ];
    if (room) options.push({ key: 'room', label: `All walls of ${room.name}`, scope: { kind: 'roomWalls', roomId: room.id } });
    return { options, roomName: room?.name, names };
  }
  const room = scene.rooms.find((r) => r.id === selection.entityId);
  if (!room) return { options: [], names };
  const options: ScopeOption[] = [];
  const zone = selection.kind === 'floor' ? room.floorZones?.find((z) => z.id === selection.zoneId) : undefined;
  if (zone) {
    // The room's own floor material, when it is a defined one: what "match the floor" gives the zone.
    const around = floorMaterial(scene, room);
    options.push({ key: 'zone', label: `This zone (${zone.name ?? zone.id})`, scope: { kind: 'zone', roomId: room.id, zoneId: zone.id, ...(scene.materials.some((m) => m.id === around) ? { resetTo: around } : {}) } });
  }
  options.push({ key: 'floor', label: zone ? 'Rest of the floor' : 'Floor', scope: { kind: 'floor', roomId: room.id } });
  // Ceilings are hidden in orbit and top view, so they are offered from the room selection.
  if (room.type !== 'balcony') options.push({ key: 'ceiling', label: 'Ceiling', scope: { kind: 'ceiling', roomId: room.id } });
  options.push({ key: 'room', label: `All walls of ${room.name}`, scope: { kind: 'roomWalls', roomId: room.id } });
  return { options, roomName: room.name, names };
}

function defaultScope(selection: Selection): ScopeKey {
  if (selection.zoneId) return 'zone';
  if (selection.kind === 'ceiling') return 'ceiling';
  if (selection.kind === 'floor') return 'floor';
  return 'side';
}

/** Material of one room's stretch of a wall face (the stretch containing `along` when it has several); the face's mid-span when no room. */
function stretchMaterial(scene: Scene, wallId: string, side: 'left' | 'right', roomId: string | undefined, along: number | undefined): string | undefined {
  const stats = wallStats(scene, wallId);
  if (!stats) return undefined;
  if (!roomId && along === undefined) return stats.finish[side];
  const faces = stats.faces[side].filter((f) => !roomId || f.roomId === roomId);
  const hit = along === undefined ? undefined : faces.find((f) => f.from - 1e-6 <= along && along <= f.to + 1e-6);
  return (hit ?? faces[0])?.material;
}

/** Material id currently on a scope's primary target (the clicked stretch of a wall side), or undefined when mixed/none. */
function scopeMaterialId(scene: Scene, scope: FinishScope, along?: number): string | undefined {
  switch (scope.kind) {
    case 'wallSide': {
      if (scope.side === 'both') {
        const l = stretchMaterial(scene, scope.wallId, 'left', scope.roomId, along);
        return l === stretchMaterial(scene, scope.wallId, 'right', scope.roomId, along) ? l : undefined;
      }
      return stretchMaterial(scene, scope.wallId, scope.side, scope.roomId, along);
    }
    case 'wallFaces': {
      const ids = new Set(scope.faces.map((f) => stretchMaterial(scene, scope.wallId, f.side, f.roomId, along)));
      return ids.size === 1 ? [...ids][0] : undefined;
    }
    case 'roomWalls':
      return scene.rooms.find((r) => r.id === scope.roomId)?.wallFinish;
    case 'floor': {
      const room = scene.rooms.find((r) => r.id === scope.roomId);
      return room && floorMaterial(scene, room);
    }
    case 'zone':
      return scene.rooms.find((r) => r.id === scope.roomId)?.floorZones?.find((z) => z.id === scope.zoneId)?.material;
    case 'ceiling': {
      const room = scene.rooms.find((r) => r.id === scope.roomId);
      return room && ceilingMaterial(scene, room);
    }
  }
}

function describeMaterial(scene: Scene, id: string | undefined): { name: string; color: string; slug?: string; material?: Material } {
  const material = scene.materials.find((m) => m.id === id);
  if (material) {
    return {
      name: materialLabel(material),
      color: material.color,
      material,
      ...(material.textureUrl?.startsWith('lib:') ? { slug: material.textureUrl.slice(4) } : {}),
    };
  }
  const builtin = Object.values(BUILTIN_MATERIALS).includes(id as never);
  return { name: id && !builtin ? id : 'Default', color: '#dcd8d0' };
}

function MaterialChip({ scene, id }: { scene: Scene; id: string | undefined }) {
  const d = describeMaterial(scene, id);
  return (
    <span className="material-chip">
      <span className="chip-swatch" style={{ background: d.color }} aria-hidden="true" />
      <span>{d.name}</span>
    </span>
  );
}

function CurrentFinish({ scene, selection }: { scene: Scene; selection: Selection }) {
  if (selection.kind === 'wall') {
    const stats = wallStats(scene, selection.entityId);
    if (!stats) return null;
    const hereRoomId = selection.roomId ?? (selection.face === 'left' || selection.face === 'right' ? clickedRooms(scene, selection)[selection.face] : undefined);
    const here = { room: scene.rooms.find((r) => r.id === hereRoomId) };
    return (
      <dl className="current-finish" aria-label="Current finish">
        {selection.face && (selection.face === 'left' || selection.face === 'right') && (
          <div>
            <dt>{here.room ? `${shortName(here.room.name)} side (here)` : `${selection.face === 'left' ? 'Left' : 'Right'} side (here)`}</dt>
            <dd data-testid="finish-here">
              <MaterialChip scene={scene} id={stretchMaterial(scene, selection.entityId, selection.face, here.room?.id, selection.along)} />
            </dd>
          </div>
        )}
        {(['left', 'right'] as const).map((side) => (
          <div key={side}>
            <dt>{side === 'left' ? 'Left side' : 'Right side'}</dt>
            <dd data-testid={`finish-${side}`}>
              {stats.mixed[side] ? (
                <span className="mixed">
                  Mixed:{' '}
                  {[...new Set(stats.faces[side].map((f) => f.material))].map((m, i) => (
                    <span key={m}>
                      {i > 0 && ', '}
                      <MaterialChip scene={scene} id={m} />
                    </span>
                  ))}
                </span>
              ) : (
                <MaterialChip scene={scene} id={stats.finish[side]} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  const room = scene.rooms.find((r) => r.id === selection.entityId);
  if (!room) return null;
  const zone = room.floorZones?.find((z) => z.id === selection.zoneId);
  return (
    <dl className="current-finish" aria-label="Current finish">
      {zone && (
        <div>
          <dt>{`Zone ${zone.name ?? zone.id}`}</dt>
          <dd data-testid="finish-zone">
            <MaterialChip scene={scene} id={zone.material} />
          </dd>
        </div>
      )}
      <div>
        <dt>{zone ? 'Floor around' : 'Floor'}</dt>
        <dd data-testid="finish-floor">
          <MaterialChip scene={scene} id={floorMaterial(scene, room)} />
        </dd>
      </div>
      {room.type !== 'balcony' && (
        <div>
          <dt>Ceiling</dt>
          <dd data-testid="finish-ceiling">
            <MaterialChip scene={scene} id={ceilingMaterial(scene, room)} />
          </dd>
        </div>
      )}
      <div>
        <dt>Walls</dt>
        <dd data-testid="finish-walls">
          <MaterialChip scene={scene} id={room.wallFinish ?? scene.defaults.wall} />
        </dd>
      </div>
    </dl>
  );
}

interface Toast {
  kind: 'warning' | 'error';
  messages: string[];
}

function sheenOf(material: Material | undefined): Sheen | undefined {
  const s = material?.kind === 'paint' ? /-(matt|satin|gloss)$/.exec(material.id)?.[1] : undefined;
  return s as Sheen | undefined;
}

/** Name of the room a room-level scope targets, plus the room-name table for wall scopes. */
function roomLevelNames(scope: FinishScope, names: FinishNames): FinishNames {
  const name = 'roomId' in scope && scope.roomId ? names.rooms?.[scope.roomId] : undefined;
  return { ...names, ...(name ? { room: name } : {}) };
}

function FinishPanelBody({ scene, selection }: { scene: Scene; selection: Selection }) {
  const dispatch = useSceneStore((s) => s.dispatch);
  const preview = useSceneStore((s) => s.preview);
  const commitPreview = useSceneStore((s) => s.commitPreview);
  const cancelPreview = useSceneStore((s) => s.cancelPreview);
  const lastErrors = useSceneStore((s) => s.lastErrors);

  const { options, names } = useMemo(() => scopeOptions(scene, selection), [scene, selection]);
  const [scopeKey, setScopeKey] = useState<ScopeKey>(defaultScope(selection));
  const option = options.find((o) => o.key === scopeKey) ?? options[0];
  const [tab, setTab] = useState<'paint' | 'textures'>('paint');
  const [category, setCategory] = useState('all');
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();

  const currentId = option ? scopeMaterialId(scene, option.scope, selection.along) : undefined;
  const current = describeMaterial(scene, currentId);
  const activePaint = current.material?.kind === 'paint' ? current.material : undefined;
  const [sheen, setSheen] = useState<Sheen>(sheenOf(activePaint) ?? 'matt');

  const catalog = useFinishCatalog(tab === 'textures');

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const show = (next: Toast | null) => {
    clearTimeout(toastTimer.current);
    setToast(next);
    if (next) toastTimer.current = setTimeout(() => setToast(null), 8000);
  };

  const report = (result: ApplyResult) => {
    if (!result.ok) show({ kind: 'error', messages: result.errors.map((e) => e.message) });
    else if (result.warnings.length) show({ kind: 'warning', messages: result.warnings.map((w) => w.message) });
    else show(null);
  };

  if (!option) return null;
  const build = (source: FinishSource) => buildFinishCommand(option.scope, source, roomLevelNames(option.scope, names));
  const apply = (source: FinishSource) => {
    const cmd = build(source);
    report(dispatch(cmd, { label: cmd.label }));
  };

  const categories = catalog.status === 'ready' ? [...new Set(catalog.entries.map((e) => e.category))] : [];
  const entries = catalog.status === 'ready' ? catalog.entries.filter((e) => category === 'all' || e.category === category) : [];

  return (
    <section className="finish-panel" aria-label="Finish" data-testid="finish-panel">
      <h3>Finish</h3>
      <CurrentFinish scene={scene} selection={selection} />

      <div role="group" aria-label="Apply to" className="scope-buttons">
        {options.map((o) => (
          <button key={o.key} type="button" aria-pressed={o.key === option.key} onClick={() => setScopeKey(o.key)}>
            {o.label}
          </button>
        ))}
      </div>

      <div role="tablist" aria-label="Finish type" className="finish-tabs">
        {(['paint', 'textures'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${id}-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`${id}-panel`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                const next = t === 'paint' ? 'textures' : 'paint';
                setTab(next);
                document.getElementById(`${id}-tab-${next}`)?.focus();
              }
            }}
          >
            {t === 'paint' ? 'Paint' : 'Textures'}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="finish-tabpanel">
        {tab === 'paint' ? (
          <ColorPicker
            activeHex={activePaint?.color ?? null}
            sheen={sheen}
            onSheen={(s) => {
              setSheen(s);
              if (activePaint) apply({ kind: 'paint', hex: activePaint.color, sheen: s });
            }}
            onApply={(hex) => apply({ kind: 'paint', hex, sheen })}
            onPreview={(hex) => {
              const result = preview(build({ kind: 'paint', hex, sheen }));
              if (!result.ok) report(result);
            }}
            onCommit={commitPreview}
            onCancel={cancelPreview}
          />
        ) : (
          <div className="texture-browser">
            <label className="field-inline">
              <span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="all">All</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c] ?? c}
                  </option>
                ))}
              </select>
            </label>
            {catalog.status === 'loading' && <p className="hint">Loading textures…</p>}
            {catalog.status === 'error' && (
              <p role="alert" className="field-error">
                Could not load the texture library ({catalog.message}).
              </p>
            )}
            {catalog.status === 'ready' && (
              <ul className="texture-grid" aria-label="Textures">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="texture-card"
                      aria-pressed={currentId === `lib-${entry.id}`}
                      aria-label={entry.name}
                      onClick={() => apply({ kind: 'catalog', entry })}
                    >
                      <img src={thumbUrl(entry.id)} alt="" loading="lazy" decoding="async" width={64} height={64} />
                      <span>{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="finish-actions">
        <button type="button" disabled={option.scope.kind === 'zone' && option.scope.resetTo === undefined} onClick={() => apply({ kind: 'reset' })}>
          {option.scope.kind === 'zone' ? 'Match the floor around' : 'Reset to default'}
        </button>
      </div>

      {toast ? (
        <div className={`finish-toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'} data-testid="finish-toast">
          <ul>
            {toast.messages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          <button type="button" className="link" onClick={() => show(null)}>
            Dismiss
          </button>
        </div>
      ) : (
        lastErrors.length > 0 && (
          <div className="finish-toast error" role="alert" data-testid="finish-toast">
            <ul>
              {lastErrors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          </div>
        )
      )}
    </section>
  );
}

/** Finish controls for the current selection: a wall side, a floor or a ceiling; a hint for anything else. */
export function FinishPanel({ scene, selection }: { scene: Scene; selection: Selection }) {
  // Furniture has its own properties (price, link, lock): the finish hint would only be noise there.
  if (selection.kind === 'item') return null;
  if (!takesFinish(selection)) {
    return (
      <p className="hint finish-note" data-testid="finish-note">
        {selection.kind === 'wall'
          ? 'Select a wall side (left or right face) to change its finish; the top and ends do not take finishes.'
          : 'Only wall sides, floors and ceilings take finishes. Select one of those to paint or texture it.'}
      </p>
    );
  }
  const key = `${selection.kind}:${selection.entityId}:${selection.face ?? ''}:${selection.roomId ?? ''}:${selection.zoneId ?? ''}`;
  return <FinishPanelBody key={key} scene={scene} selection={selection} />;
}
