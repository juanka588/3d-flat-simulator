import { roomStats, wallEdgeMaterial, wallSideMaterial, wallStats } from '@flat/scene';
import type { Scene } from '@flat/scene';
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

export function PropertiesPanel({ scene, selection }: { scene: Scene; selection: Selection | null }) {
  const info = selection ? describe(scene, selection) : null;
  return (
    <aside aria-label="Properties" className="panel properties" data-testid="properties">
      {info ? (
        <>
          <h2>{info.title}</h2>
          <Rows rows={info.rows} />
        </>
      ) : (
        <p className="hint">Click a wall, floor, door or window to inspect it.</p>
      )}
    </aside>
  );
}
