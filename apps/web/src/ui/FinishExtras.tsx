import { useState } from 'react';
import type { BatchCommand, Material, Scene } from '@flat/scene';
import {
  MOULDING_STYLES,
  PARQUET_PATTERNS,
  PARQUET_TONES,
  buildCorniceCommand,
  buildMouldingCommand,
  buildParquetCommand,
} from './finish-commands';
import type { FinishNames, FinishScope, MouldingStyle, ParquetPattern } from './finish-commands';

type Apply = (cmd: BatchCommand) => void;

/** Mouldings (boiserie) now showing on a wall or room scope: the wall side's own, else the room's, else none. */
export function currentMouldings(scene: Scene, scope: FinishScope, roomId: string | undefined): MouldingStyle {
  const roomStyle = (id: string | undefined) => scene.rooms.find((r) => r.id === id)?.panelling?.style;
  if (scope.kind === 'roomWalls') return roomStyle(scope.roomId) ?? 'none';
  const face = scope.kind === 'wallSide' ? (scope.side === 'both' ? 'left' : scope.side) : scope.kind === 'wallFaces' ? scope.faces[0]?.side : undefined;
  const wall = 'wallId' in scope ? scene.walls.find((w) => w.id === scope.wallId) : undefined;
  return (face ? wall?.panelling?.[face]?.style : undefined) ?? roomStyle(roomId) ?? 'none';
}

/** Moulding style and (for a whole room) cornice controls of the finish panel. */
export function MouldingControls({ scene, scope, names, roomId, apply }: { scene: Scene; scope: FinishScope; names: FinishNames; roomId: string | undefined; apply: Apply }) {
  const style = currentMouldings(scene, scope, roomId);
  const room = scope.kind === 'roomWalls' ? scene.rooms.find((r) => r.id === scope.roomId) : undefined;
  return (
    <fieldset className="finish-extras" data-testid="mouldings">
      <legend>Mouldings</legend>
      <label className="field-inline">
        <span>Panelling</span>
        <select
          aria-label="Panelling"
          value={style}
          onChange={(e) => {
            const cmd = buildMouldingCommand(scope, e.target.value as MouldingStyle, names);
            if (cmd) apply(cmd);
          }}
        >
          {MOULDING_STYLES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {room && (
        <label className="field-inline">
          <input type="checkbox" checked={room.cornice !== undefined} onChange={(e) => apply(buildCorniceCommand(room.id, e.target.checked, names))} />
          <span>Ceiling cornice</span>
        </label>
      )}
    </fieldset>
  );
}

/** Herringbone / chevron parquet for a floor or floor zone. */
export function ParquetControls({ scope, names, current, apply }: { scope: FinishScope; names: FinishNames; current: Material | undefined; apply: Apply }) {
  const [tone, setTone] = useState<string>(current?.pattern ? current.color : PARQUET_TONES[0]!.hex);
  return (
    <fieldset className="finish-extras" data-testid="parquet">
      <legend>Parquet</legend>
      <label className="field-inline">
        <span>Wood tone</span>
        <select aria-label="Wood tone" value={tone} onChange={(e) => setTone(e.target.value)}>
          {PARQUET_TONES.map((t) => (
            <option key={t.hex} value={t.hex}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <div role="group" aria-label="Parquet pattern" className="scope-buttons">
        {PARQUET_PATTERNS.map((p) => (
          <button
            key={p.value}
            type="button"
            aria-pressed={current?.pattern === p.value}
            onClick={() => {
              const cmd = buildParquetCommand(scope, p.value as ParquetPattern, tone, names);
              if (cmd) apply(cmd);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
