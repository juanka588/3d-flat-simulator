import type { Item, Scene } from '@flat/scene';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import type { ModelController } from './model-controller';
import { viewerConfig } from './config';
import { itemMatrix } from './model-math';
import { activeModelController, createViewerModelController, setActiveModelController } from './model-runtime';
import type { ModelTemplate } from './model-loader';
import { CLICK_DRAG_TOLERANCE_PX } from './ShellMesh';
import type { Selection } from './view-types';

/** Same model this many times or more is drawn as one `InstancedMesh` per part. */
export const INSTANCING_THRESHOLD = 3;

export interface ItemModels {
  controller: ModelController<ModelTemplate>;
  /** Ids of the items ItemsMesh draws (a placeholder while loading, then the model); `buildItems` must skip them. */
  claimed: ReadonlySet<string>;
  /** Items whose model could not be used and that are drawn from a generator instead (by id). */
  fallbacks: ReadonlyMap<string, Extract<NonNullable<Item['mesh']>, { kind: 'parametric' }>>;
  version: number;
}

/**
 * One model controller per canvas, kept in step with the scene's items. Call it where the scene is drawn;
 * `claimed` is what `ItemsMesh` takes over from the shell's `buildItems` mesh.
 */
export function useItemModels(scene: Scene, invalidate: () => void): ItemModels {
  const [controller] = useState(createViewerModelController);
  const version = useSyncExternalStore(controller.subscribe, controller.getVersion);
  // The server origin is part of what decides a model: re-render (and so re-resolve) when it appears, changes or goes.
  useSyncExternalStore(viewerConfig.subscribe, viewerConfig.modelOrigin);
  // Idempotent and silent (listeners are only told from async work), so it is fine while rendering.
  controller.update(scene.items);
  const claimed = controller.claimed();
  const fallbacks = controller.fallbacks();
  useEffect(() => {
    setActiveModelController(controller);
    const stop = controller.subscribe(invalidate);
    return () => {
      stop();
      if (activeModelController() === controller) setActiveModelController(null);
      controller.dispose();
    };
  }, [controller, invalidate]);
  return { controller, claimed, fallbacks, version };
}

const unitBox = new BoxGeometry(1, 1, 1);
unitBox.translate(0, 0.5, 0); // bottom at y = 0, centred on x/z: scaled by the item's dims it IS the item frame.
const placeholderMaterial = new MeshStandardMaterial({ color: '#cfd2d8', roughness: 0.9, metalness: 0 });
const tintMaterial = new MeshBasicMaterial({ color: '#ff9f1a', transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

interface DrawnObject {
  key: string;
  object: Mesh | Group;
  /** One item id for a plain object; the per-instance ids of an InstancedMesh group. */
  itemIds: readonly string[];
}

const scratch = new Matrix4();

/** Meshes of the parts of a template, set up for shadows and picking. */
function partMeshes(template: ModelTemplate, make: (geometry: ModelTemplate['parts'][number]['geometry'], material: ModelTemplate['parts'][number]['material']) => Mesh): Mesh[] {
  return template.parts.map((p) => {
    const mesh = make(p.geometry, p.material);
    mesh.name = 'items-glb';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  });
}

/** Builds the drawable objects for the ready items: instanced when a model repeats, plain meshes otherwise. */
export function buildDrawn(items: readonly Item[], controller: ModelController<ModelTemplate>): DrawnObject[] {
  const byModel = new Map<string, { template: ModelTemplate; items: Item[] }>();
  for (const item of items) {
    const s = controller.state(item.id);
    if (s?.status !== 'ready' || !s.model || !s.url) continue;
    const g = byModel.get(s.url) ?? { template: s.model, items: [] };
    g.items.push(item);
    byModel.set(s.url, g);
  }
  const out: DrawnObject[] = [];
  for (const [url, { template, items: list }] of byModel) {
    const matrixOf = (item: Item, m: Matrix4) => {
      const s = controller.state(item.id)!;
      return itemMatrix(item, template.box, s.front, s.dims, m);
    };
    if (list.length >= INSTANCING_THRESHOLD) {
      const ids = list.map((i) => i.id);
      partMeshes(template, (geometry, material) => {
        const im = new InstancedMesh(geometry, material, list.length);
        list.forEach((item, i) => im.setMatrixAt(i, matrixOf(item, scratch)));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        return im;
      }).forEach((mesh, i) => {
        mesh.userData['itemIds'] = ids;
        out.push({ key: `${url}#${i}`, object: mesh, itemIds: ids });
      });
    } else {
      for (const item of list) {
        const group = new Group();
        group.name = 'item-glb';
        group.userData['itemId'] = item.id;
        for (const mesh of partMeshes(template, (g, m) => new Mesh(g, m))) group.add(mesh);
        matrixOf(item, group.matrix);
        group.matrixAutoUpdate = false;
        group.matrixWorldNeedsUpdate = true;
        out.push({ key: item.id, object: group, itemIds: [item.id] });
      }
    }
  }
  return out;
}

interface ItemsMeshProps {
  scene: Pick<Scene, 'items'>;
  models: ItemModels;
  selectedId?: string;
  /** Omit to make items non-interactive (walk mode). */
  onSelect?: (selection: Selection, planPoint: [number, number]) => void;
}

/**
 * Items drawn from GLB models (provider or lookalike), plus a placeholder box at the item's exact dims for
 * every item whose model is still loading (so nothing moves when it arrives). Items without a model keep
 * coming from the shell's `buildItems` mesh. Models cast and receive shadows.
 */
export function ItemsMesh({ scene, models, selectedId, onSelect }: ItemsMeshProps) {
  const { controller, claimed, version } = models;
  // `version` is part of the key: any state change (a model arrived, a fallback happened) redraws.
  const drawn = useMemo(() => buildDrawn(scene.items, controller), [scene.items, controller, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      // Geometry and materials belong to the cache; an InstancedMesh only owns its instance buffer.
      for (const d of drawn) if ((d.object as InstancedMesh).isInstancedMesh) (d.object as InstancedMesh).dispose();
    },
    [drawn],
  );

  const pick = (ids: readonly string[]) =>
    onSelect
      ? (e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.delta > CLICK_DRAG_TOLERANCE_PX) return;
          const id = ids[e.instanceId ?? 0];
          if (id) onSelect({ kind: 'item', entityId: id }, [e.point.x, e.point.z]);
        }
      : undefined;

  const loading = scene.items.filter((i) => claimed.has(i.id) && controller.state(i.id)?.status === 'loading');
  const selected = selectedId && claimed.has(selectedId) ? scene.items.find((i) => i.id === selectedId) : undefined;

  return (
    <group name="items-models">
      {drawn.map((d) => (
        <primitive key={d.key} object={d.object} onClick={pick(d.itemIds)} />
      ))}
      {loading.map((item) => {
        const dims = controller.state(item.id)!.dims;
        return (
          <mesh
            key={item.id}
            name="item-placeholder"
            userData={{ itemId: item.id }}
            geometry={unitBox}
            material={placeholderMaterial}
            position={[item.position[0], item.elevation, item.position[1]]}
            rotation={[0, (item.rotation * Math.PI) / 180, 0]}
            scale={[dims.w, dims.h, dims.d]}
            onClick={pick([item.id])}
          />
        );
      })}
      {selected && <SelectionBox item={selected} controller={controller} />}
    </group>
  );
}

/** Orange tint over the selected model item's box (the shell highlight only knows `buildItems` triangles). */
function SelectionBox({ item, controller }: { item: Item; controller: ModelController<ModelTemplate> }) {
  const dims = controller.state(item.id)?.dims;
  if (!dims) return null;
  const grow = 1.01;
  return (
    <mesh
      name="selection-highlight"
      geometry={unitBox}
      material={tintMaterial}
      raycast={() => null}
      renderOrder={10}
      position={[item.position[0], item.elevation, item.position[1]]}
      rotation={[0, (item.rotation * Math.PI) / 180, 0]}
      scale={[dims.w * grow, dims.h * grow, dims.d * grow]}
    />
  );
}
