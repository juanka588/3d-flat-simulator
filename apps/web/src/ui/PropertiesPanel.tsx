import { BUILTIN_ASSETS, itemLabel, roomStats, wallEdgeMaterial, wallStats } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { useId, useState } from 'react';
import { readPref, writePref } from '../state/prefs';
import type { Selection } from '../viewer/view-types';
import { FinishPanel, takesFinish } from './FinishPanel';
import { HistoryButtons } from './HistoryButtons';
import { StructuralControl } from './StructuralControl';

/** Desktop: whether the properties dock is collapsed ('1') or open ('0'). Remembered across visits. */
export const PROPERTIES_COLLAPSED_KEY = 'flat.propertiesCollapsed';

const m = (v: number) => `${v.toFixed(2)} m`;
const m2 = (v: number) => `${v.toFixed(2)} m²`;

function materialName(scene: Scene, id: string | undefined): string {
  return scene.materials.find((x) => x.id === id)?.name ?? id ?? 'default';
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

interface Description {
  title: string;
  rows: [string, string][];
  /** One line for the compact mobile sheet. */
  summary: string;
}

function describe(scene: Scene, selection: Selection): Description | null {
  if (selection.kind === 'wall') {
    const wall = scene.walls.find((w) => w.id === selection.entityId);
    const stats = wallStats(scene, selection.entityId);
    if (!wall || !stats) return null;
    const face = selection.face;
    const side = face === 'left' || face === 'right' ? face : undefined;
    // Room-aware: the material of each stretch of the face (a room-scoped finish may cover only part of a shared side).
    const material = side
      ? [...new Set(stats.faces[side].map((f) => materialName(scene, f.material)))].join(' / ')
      : materialName(scene, wallEdgeMaterial(scene));
    return {
      title: `Wall ${wall.id}`,
      summary: `${face ?? 'edge'} · ${m(stats.length)} · ${material}`,
      rows: [
        ['Side', face ?? '-'],
        ['Length', m(stats.length)],
        ['Thickness', m(stats.thickness)],
        ['Height', m(stats.height)],
        ['Material', material],
        ['Net area', face === 'right' ? m2(stats.netArea.right) : m2(stats.netArea.left)],
      ],
    };
  }
  if (selection.kind === 'floor' || selection.kind === 'ceiling') {
    const stats = roomStats(scene, selection.entityId);
    const room = scene.rooms.find((r) => r.id === selection.entityId);
    if (!stats || !room) return null;
    return {
      title: stats.name,
      summary: `${selection.kind} · ${m2(stats.area)} · ${materialName(scene, selection.kind === 'floor' ? stats.floorMaterial : (stats.ceilingMaterial ?? undefined))}`,
      rows: [
        ['Surface', selection.kind],
        ['Type', room.type],
        ['Area', m2(stats.area)],
        ['Perimeter', m(stats.perimeter)],
        ['Floor material', materialName(scene, stats.floorMaterial)],
      ],
    };
  }
  if (selection.kind === 'item') {
    const item = scene.items.find((i) => i.id === selection.entityId);
    if (!item) return null;
    const asset = BUILTIN_ASSETS[item.assetId];
    return {
      title: itemLabel(item),
      summary: `${item.roomId ?? 'no room'} · elevation ${m(item.elevation)}`,
      rows: [
        ['Id', item.id],
        ['Room', item.roomId ?? '-'],
        ['Elevation', m(item.elevation)],
        ['Rotation', `${item.rotation}°`],
        ...(asset ? ([['Mount', asset.mount]] as [string, string][]) : []),
      ],
    };
  }
  const opening = scene.openings.find((o) => o.id === selection.entityId);
  if (!opening) return null;
  return {
    title: `${opening.type} ${opening.id}`,
    summary: `${m(opening.width)} × ${m(opening.height)} on ${opening.wallId}`,
    rows: [
      ['Wall', opening.wallId],
      ['Width', m(opening.width)],
      ['Height', m(opening.height)],
      ['Sill', m(opening.sill)],
    ],
  };
}

/** Details, structural status (walls) and finish controls for a selection. */
function SelectionBody({ scene, selection, rows, history = false }: { scene: Scene; selection: Selection; rows: [string, string][]; history?: boolean }) {
  return (
    <>
      <Rows rows={rows} />
      {selection.kind === 'wall' && <StructuralControl scene={scene} wallId={selection.entityId} />}
      {history && <HistoryButtons />}
      <FinishPanel scene={scene} selection={selection} />
    </>
  );
}

interface PropertiesPanelProps {
  scene: Scene;
  selection: Selection | null;
  /**
   * Mobile layout: a bottom sheet shown only while something is selected. It opens compact (summary
   * and a Finish button) and expands on demand.
   */
  sheet?: boolean;
  /** Render nothing (the sheet stays out of the way of the walk controls). */
  hidden?: boolean;
}

export function PropertiesPanel({ scene, selection, sheet = false, hidden = false }: PropertiesPanelProps) {
  // Mobile: the selection whose sheet the user expanded (a new selection always opens compact).
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  // Desktop: the dock collapses to its title bar (remembered).
  const [dockCollapsed, setDockCollapsed] = useState(() => readPref(PROPERTIES_COLLAPSED_KEY) === '1');
  const bodyId = useId();
  const info = selection ? describe(scene, selection) : null;
  if (hidden) return null;
  if (!sheet) {
    if (!info || !selection) {
      return (
        <aside aria-label="Properties" className="panel properties" data-testid="properties">
          <p className="hint">Click a wall, floor, door, window or item to inspect it.</p>
        </aside>
      );
    }
    const toggleDock = () => {
      writePref(PROPERTIES_COLLAPSED_KEY, dockCollapsed ? '0' : '1');
      setDockCollapsed(!dockCollapsed);
    };
    return (
      <aside aria-label="Properties" className={`panel properties has-finish${dockCollapsed ? ' collapsed' : ''}`} data-testid="properties">
        <div className="properties-head">
          <h2>{info.title}</h2>
          <button
            type="button"
            className="dock-toggle"
            aria-expanded={!dockCollapsed}
            aria-controls={bodyId}
            title={dockCollapsed ? 'Show details' : 'Hide details'}
            onClick={toggleDock}
          >
            <span aria-hidden="true">{dockCollapsed ? '▾' : '▴'}</span>
            <span className="visually-hidden">{dockCollapsed ? 'Show details' : 'Hide details'}</span>
          </button>
        </div>
        <div id={bodyId} hidden={dockCollapsed}>
          <SelectionBody scene={scene} selection={selection} rows={info.rows} />
        </div>
      </aside>
    );
  }
  if (!info || !selection) return null;
  const key = `${selection.kind}:${selection.entityId}:${selection.face ?? ''}`;
  const expanded = expandedFor === key;
  const canFinish = takesFinish(selection);
  return (
    <aside aria-label="Properties" className={`panel properties properties-sheet${expanded ? ' expanded' : ' compact'}`} data-testid="properties">
      <button
        type="button"
        className="sheet-handle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpandedFor(expanded ? null : key)}
      >
        <span className="sheet-title">{info.title}</span>
        <span aria-hidden="true">{expanded ? '▼' : '▲'}</span>
        <span className="visually-hidden">{expanded ? 'Hide details' : 'Show details'}</span>
      </button>
      {!expanded && (
        <div className="sheet-compact">
          <p className="sheet-summary" data-testid="sheet-summary">
            {info.summary}
          </p>
          {canFinish && (
            <button type="button" className="sheet-finish" onClick={() => setExpandedFor(key)}>
              Finish
            </button>
          )}
        </div>
      )}
      <div id={bodyId} hidden={!expanded}>
        {expanded && <SelectionBody scene={scene} selection={selection} rows={info.rows} history />}
      </div>
    </aside>
  );
}
