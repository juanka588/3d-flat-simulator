import { polygonArea } from '@flat/scene';
import type { FloorZone, Room, Scene } from '@flat/scene';
import { useState } from 'react';
import { addZoneCommand } from '../catalog/zones';
import { useSceneStore } from '../state/sceneStore';
import { useViewStore } from '../state/viewStore';
import type { Selection } from '../viewer/view-types';

const m2 = (v: number) => `${v.toFixed(2)} m²`;

/** One zone of the list (keyed by id and name, so the field restarts from the stored name): select it, rename it (Enter or leaving the field saves), remove it. */
function ZoneRow({ scene, room, zone, selected }: { scene: Scene; room: Room; zone: FloorZone; selected: boolean }) {
  const dispatch = useSceneStore((s) => s.dispatch);
  const select = useViewStore((s) => s.select);
  const [name, setName] = useState(zone.name ?? '');
  const material = scene.materials.find((x) => x.id === zone.material);
  const label = zone.name ?? zone.id;

  const rename = () => {
    const next = name.trim();
    if (next === (zone.name ?? '')) return;
    const { name: _drop, ...rest } = zone;
    void _drop;
    dispatch({ type: 'room.setFloorZone', roomId: room.id, zone: next ? { ...rest, name: next } : rest }, { label: next ? `Rename floor zone ${label} to ${next}` : `Clear the name of floor zone ${label}` });
  };

  return (
    <li className={`zone-row${selected ? ' selected' : ''}`} data-testid={`zone-row-${zone.id}`}>
      <button type="button" className="zone-pick" aria-pressed={selected} onClick={() => select({ kind: 'floor', entityId: room.id, zoneId: zone.id })}>
        <span className="chip-swatch" style={{ background: material?.color ?? '#dcd8d0' }} aria-hidden="true" />
        <span className="zone-title">{label}</span>
        <span className="zone-meta">
          {m2(polygonArea(zone.polygon))} · {material?.name ?? zone.material}
        </span>
      </button>
      <label className="zone-rename">
        <span className="visually-hidden">{`Name of zone ${zone.id}`}</span>
        <input
          type="text"
          value={name}
          maxLength={120}
          placeholder="Name"
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') setName(zone.name ?? '');
          }}
        />
      </label>
      <button
        type="button"
        className="zone-remove"
        aria-label={`Remove zone ${label}`}
        onClick={() => dispatch({ type: 'room.removeFloorZone', roomId: room.id, zoneId: zone.id }, { label: `Remove floor zone ${label} from ${room.name}` })}
      >
        Remove
      </button>
    </li>
  );
}

/**
 * The floor zones of the selected room (or of the room of the selected zone): add a 1 x 1 m zone at the room's centre,
 * select, rename and remove zones. Corner handles in the plan resize the selected zone (viewer/ZoneEditor.tsx).
 * Every edit is a command, so undo, redo, history and live sync work as for any other edit.
 */
export function FloorZones({ scene, selection }: { scene: Scene; selection: Selection }) {
  const dispatch = useSceneStore((s) => s.dispatch);
  const select = useViewStore((s) => s.select);
  const [notice, setNotice] = useState<string | null>(null);
  const room = scene.rooms.find((r) => r.id === selection.entityId);
  if (selection.kind !== 'floor' || !room) return null;
  const zones = room.floorZones ?? [];

  const add = () => {
    const made = addZoneCommand(scene, room);
    if (!made) {
      setNotice('There is no free 25 cm square left in this room for a new zone.');
      return;
    }
    const result = dispatch(made.command, { label: `Add floor zone in ${room.name}` });
    if (!result.ok) {
      setNotice(result.errors[0]?.message ?? 'The zone could not be added.');
      return;
    }
    setNotice(null);
    select({ kind: 'floor', entityId: room.id, zoneId: made.zoneId });
  };

  return (
    <section className="floor-zones" aria-label="Floor zones" data-testid="floor-zones">
      <h3>Floor zones</h3>
      {zones.length === 0 ? (
        <p className="hint">A zone is a part of the floor with its own material, such as tiles in a kitchen corner.</p>
      ) : (
        <ul className="zone-list">
          {zones.map((z) => (
            <ZoneRow key={`${z.id}:${z.name ?? ''}`} scene={scene} room={room} zone={z} selected={selection.zoneId === z.id} />
          ))}
        </ul>
      )}
      <div className="finish-actions">
        <button type="button" onClick={add} data-testid="add-zone">
          Add zone
        </button>
        {selection.zoneId && (
          <button type="button" onClick={() => select({ kind: 'floor', entityId: room.id })}>
            Select the whole floor
          </button>
        )}
      </div>
      {selection.zoneId && <p className="hint">Drag the orange corner dots in the plan to resize the zone; they snap to 5 cm and stop at the walls. Hold Alt for free movement.</p>}
      {notice && (
        <p role="alert" className="field-error" data-testid="zone-notice">
          {notice}
        </p>
      )}
    </section>
  );
}
