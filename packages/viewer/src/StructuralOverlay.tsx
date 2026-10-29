import { useEffect, useMemo } from 'react';
import { BufferGeometry, CanvasTexture, DoubleSide, Float32BufferAttribute, RepeatWrapping } from 'three';
import type { Scene } from '@flat/scene';
import { wallFootprints } from './structural-footprints';

export const STRUCTURAL_COLOR = '#2a2f3a';
export const REMOVABLE_COLOR = '#f2c14e';

/** Hatching for structural walls: dark diagonal stripes on a dark ground (one repeat = 0.25 m on the plan). */
function hatchTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = STRUCTURAL_COLOR;
  g.fillRect(0, 0, 32, 32);
  g.strokeStyle = '#8b93a5';
  g.lineWidth = 5;
  for (const o of [-32, 0, 32]) {
    g.beginPath();
    g.moveTo(o, 32);
    g.lineTo(o + 32, 0);
    g.stroke();
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(4, 4);
  return t;
}

function footprintGeometry(scene: Scene, structural: boolean): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  let top = 0;
  for (const f of wallFootprints(scene)) {
    if (f.structural !== structural) continue;
    top = Math.max(top, f.height);
    const base = positions.length / 3;
    for (const [x, z] of f.corners) {
      positions.push(x, 0, z);
      uvs.push(x, z);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // Lifted just above the tallest wall top so the overlay is never hidden by the walls.
  for (let i = 1; i < positions.length; i += 3) positions[i] = top + 0.02;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  return g;
}

/**
 * Top view only: wall footprints coloured by status (structural: dark, hatched; removable
 * partition: light amber). The legend and the show/hide toggle live in the toolbar.
 */
export function StructuralOverlay({ scene }: { scene: Scene }) {
  const structural = useMemo(() => footprintGeometry(scene, true), [scene]);
  const removable = useMemo(() => footprintGeometry(scene, false), [scene]);
  const hatch = useMemo(() => hatchTexture(), []);
  useEffect(() => () => structural.dispose(), [structural]);
  useEffect(() => () => removable.dispose(), [removable]);
  useEffect(() => () => hatch.dispose(), [hatch]);
  return (
    <group name="structural-overlay">
      <mesh name="structural-walls" geometry={structural} renderOrder={10} raycast={() => null}>
        <meshBasicMaterial map={hatch} side={DoubleSide} toneMapped={false} />
      </mesh>
      <mesh name="removable-walls" geometry={removable} renderOrder={10} raycast={() => null}>
        <meshBasicMaterial color={REMOVABLE_COLOR} side={DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  );
}
