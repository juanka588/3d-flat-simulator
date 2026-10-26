import { BUILTIN_ASSETS, itemLabel, roomStats, wallEdgeMaterial, wallSideMaterial, wallStats } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { useState } from 'react';
import type { Selection } from '../viewer/view-types';

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

function describe(scene: Scene, selection: Selection): { title: string; rows: [string, string][] } | null {
  if (selection.kind === 'wall') {
    const wall = scene.walls.find((w) => w.id === selection.entityId);
    const stats = wallStats(scene, selection.entityId);
    if (!wall || !stats) return null;
    const face = selection.face;
    const side = face === 'left' || face === 'right' ? face : undefined;
    const material = side ? wallSideMaterial(scene, wall, side) : wallEdgeMaterial(scene);
    return {
      title: `Wall ${wall.id}`,
      rows: [
        ['Side', face ?? '-'],
        ['Length', m(stats.length)],
        ['Thickness', m(stats.thickness)],
        ['Height', m(stats.height)],
        ['Material', materialName(scene, material)],
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
    rows: [
      ['Wall', opening.wallId],
      ['Width', m(opening.width)],
      ['Height', m(opening.height)],
      ['Sill', m(opening.sill)],
    ],
  };
}

interface PropertiesPanelProps {
  scene: Scene;
  selection: Selection | null;
  /** Mobile layout: a collapsible bottom sheet, shown only while something is selected. */
  sheet?: boolean;
  /** Render nothing (the sheet stays out of the way of the walk controls). */
  hidden?: boolean;
}

export function PropertiesPanel({ scene, selection, sheet = false, hidden = false }: PropertiesPanelProps) {
  const [collapsedFor, setCollapsedFor] = useState<string | null>(null);
  const info = selection ? describe(scene, selection) : null;
  if (hidden) return null;
  if (!sheet) {
    return (
      <aside aria-label="Properties" className="panel properties" data-testid="properties">
        {info ? (
          <>
            <h2>{info.title}</h2>
            <Rows rows={info.rows} />
          </>
        ) : (
          <p className="hint">Click a wall, floor, door, window or item to inspect it.</p>
        )}
      </aside>
    );
  }
  if (!info || !selection) return null;
  // A new selection always opens the sheet; the user's collapse applies to that selection only.
  const key = `${selection.kind}:${selection.entityId}:${selection.face ?? ''}`;
  const collapsed = collapsedFor === key;
  return (
    <aside aria-label="Properties" className={`panel properties properties-sheet${collapsed ? ' collapsed' : ''}`} data-testid="properties">
      <button
        type="button"
        className="sheet-handle"
        aria-expanded={!collapsed}
        aria-controls="properties-body"
        onClick={() => setCollapsedFor(collapsed ? null : key)}
      >
        <span className="sheet-title">{info.title}</span>
        <span aria-hidden="true">{collapsed ? '▲' : '▼'}</span>
        <span className="visually-hidden">{collapsed ? 'Show details' : 'Hide details'}</span>
      </button>
      <div id="properties-body" hidden={collapsed}>
        <Rows rows={info.rows} />
      </div>
    </aside>
  );
}
