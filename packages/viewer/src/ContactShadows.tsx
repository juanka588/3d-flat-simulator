import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import type { Item, MeshData, Scene } from '@flat/scene';
import { BufferAttribute, BufferGeometry, DataTexture, DoubleSide, LinearFilter, MeshBasicMaterial, PlaneGeometry, RGBAFormat, UnsignedByteType } from 'three';
import { DEFAULT_CEILING_HEIGHT, roomCeilingHeight } from '@flat/scene';
import type { ModelController } from './model-controller';
import type { ModelTemplate } from './model-loader';
import { boxContactRect, creaseMesh, meshContactRects, planBounds, rasterContactShadows, wallRects } from './contact-shadows';
import type { ContactRect } from './contact-shadows';

/** Resolution of the shadow image (cells per metre, capped so a big flat stays within `MAX_CELLS` on its long side). */
const CELLS_PER_METRE = 80;
const MAX_CELLS = 1280;
/** Height of the plane above the floors (which sit at 0): enough to never lose the depth test, too little to see. */
const PLANE_Y = 0.006;

/**
 * Soft contact shadows under floor-standing furniture and creases along the walls (see contact-shadows.ts): one
 * translucent plane over the flat, its image rasterised once per scene / item layout. Not pickable.
 */
export function ContactShadows({
  scene,
  itemMesh,
  controller,
  version,
}: {
  scene: Pick<Scene, 'items' | 'walls' | 'rooms' | 'openings'>;
  itemMesh: MeshData;
  controller: ModelController<ModelTemplate>;
  version: number;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const built = useMemo(() => {
    const bounds = planBounds(scene);
    if (!bounds) return null;
    const rects: ContactRect[] = meshContactRects(scene.items as readonly Item[], itemMesh);
    for (const item of scene.items) {
      const s = controller.state(item.id);
      if (s?.dims && (s.status === 'ready' || s.status === 'loading')) {
        const r = boxContactRect(item, s.dims);
        if (r) rects.push(r);
      }
    }
    const w = bounds.x1 - bounds.x0;
    const d = bounds.z1 - bounds.z0;
    const ppm = Math.min(CELLS_PER_METRE, MAX_CELLS / Math.max(w, d));
    const image = rasterContactShadows(bounds, ppm, rects, wallRects(scene));
    const texture = new DataTexture(image.data, image.width, image.height, RGBAFormat, UnsignedByteType);
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: DoubleSide, toneMapped: false });
    const geometry = new PlaneGeometry(w, d);
    geometry.rotateX(-Math.PI / 2);
    // Gradients on the inner wall faces (floor, ceiling and corner creases).
    const crease = creaseMesh(scene, (room) => (room.type === 'balcony' && room.ceilingHeight === undefined ? 2.2 : roomCeilingHeight(scene, room) || DEFAULT_CEILING_HEIGHT));
    const creaseGeometry = new BufferGeometry();
    creaseGeometry.setAttribute('position', new BufferAttribute(crease.positions, 3));
    creaseGeometry.setAttribute('color', new BufferAttribute(crease.colors, 4));
    creaseGeometry.setIndex(new BufferAttribute(crease.indices, 1));
    const creaseMaterial = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: DoubleSide, toneMapped: false });
    return { bounds, texture, material, geometry, creaseGeometry, creaseMaterial };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` changes when a model arrives or fails (its dims may change)
  }, [scene.items, scene.walls, scene.rooms, scene.openings, itemMesh, controller, version]);
  useEffect(() => {
    invalidate();
    return () => {
      built?.texture.dispose();
      built?.material.dispose();
      built?.geometry.dispose();
      built?.creaseGeometry.dispose();
      built?.creaseMaterial.dispose();
    };
  }, [built, invalidate]);
  if (!built) return null;
  const { bounds } = built;
  return (
    <group name="contact-shadows">
      <mesh name="floor-contact" geometry={built.geometry} material={built.material} position={[(bounds.x0 + bounds.x1) / 2, PLANE_Y, (bounds.z0 + bounds.z1) / 2]} renderOrder={0.5} raycast={() => null} />
      <mesh name="wall-creases" geometry={built.creaseGeometry} material={built.creaseMaterial} renderOrder={0.5} raycast={() => null} frustumCulled={false} />
    </group>
  );
}
