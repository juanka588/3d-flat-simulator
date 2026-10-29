/**
 * Classes and instance ids of the segmentation passes (pure, no three).
 *
 * `ids` paints every pixel with the fixed colour of its class (`CLASS_COLORS`); `instances` paints it with the colour of
 * the entity (wall, opening, room floor, item, lamp...) it shows. The instance colours are a function of the sorted list of
 * the scene's entities (`entityColor`), so the same scene always gives the same map; the legend lists the entities that
 * actually appear, with their pixel counts.
 */
import type { Item, Opening, Owner, Scene } from '@flat/scene';

export const PASS_CLASSES = ['background', 'wall', 'floor', 'ceiling', 'window', 'door', 'locked_fitting', 'item', 'light_fixture', 'context', 'other'] as const;
export type PassClass = (typeof PASS_CLASSES)[number];

/** Fixed colour of each class (RGB bytes). `window` is windows and every glazed pane; `locked_fitting` is locked (existing) furniture. */
export const CLASS_COLORS: Readonly<Record<PassClass, readonly [number, number, number]>> = {
  background: [0, 0, 0],
  wall: [128, 128, 128],
  floor: [140, 90, 40],
  ceiling: [200, 200, 255],
  window: [0, 170, 255],
  door: [160, 32, 240],
  locked_fitting: [230, 25, 75],
  item: [60, 180, 75],
  light_fixture: [255, 225, 25],
  context: [70, 240, 240],
  other: [255, 0, 255],
};

export type EntityKind = 'wall' | 'opening' | 'floor' | 'ceiling' | 'item' | 'light' | 'context';

export interface Entity {
  /** `wall:<id>`, `opening:<id>`, `floor:<roomId>` (`floor:<roomId>/<zoneId>` for a floor zone), `ceiling:<roomId>`, `item:<id>`, `light:<id>` or `context`. */
  key: string;
  kind: EntityKind;
  id: string;
  class: PassClass;
  roomId?: string;
  /** Opening type, or a product name for an item. */
  detail?: string;
}

export interface LegendEntry {
  color: [number, number, number];
  hex: string;
  class: PassClass;
  kind: EntityKind;
  id: string;
  roomId?: string;
  detail?: string;
  /** Pixels of the image with this colour. */
  pixels: number;
}

export interface ClassLegendEntry {
  class: PassClass;
  color: [number, number, number];
  hex: string;
  pixels: number;
}

export const hex = (c: readonly [number, number, number]): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** The 1-based entity number to a colour: multiplying by an odd constant modulo 2^24 is a bijection, so colours never repeat and are never black. */
export function entityColor(n: number): [number, number, number] {
  const v = (Math.imul(n, 0x9e3779) & 0xffffff) >>> 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export const packRgb = (c: readonly [number, number, number]): number => (c[0] << 16) | (c[1] << 8) | c[2];

/** What the passes need to know about a scene: entity classes and their colours. */
export class SceneIndex {
  readonly entities = new Map<string, Entity>();
  private readonly colors = new Map<string, [number, number, number]>();
  private readonly openings = new Map<string, Opening>();
  private readonly items = new Map<string, Item>();
  private next = 1;

  constructor(scene: Scene) {
    const add = (e: Entity) => this.entities.set(e.key, e);
    add({ key: 'context', kind: 'context', id: 'context', class: 'context' });
    for (const w of scene.walls) add({ key: `wall:${w.id}`, kind: 'wall', id: w.id, class: 'wall' });
    for (const o of scene.openings) {
      this.openings.set(o.id, o);
      add({ key: `opening:${o.id}`, kind: 'opening', id: o.id, class: o.type === 'window' ? 'window' : 'door', detail: o.type });
    }
    for (const r of scene.rooms) {
      add({ key: `floor:${r.id}`, kind: 'floor', id: r.id, class: 'floor', roomId: r.id });
      add({ key: `ceiling:${r.id}`, kind: 'ceiling', id: r.id, class: 'ceiling', roomId: r.id });
      for (const z of r.floorZones ?? []) add({ key: `floor:${r.id}/${z.id}`, kind: 'floor', id: `${r.id}/${z.id}`, class: 'floor', roomId: r.id, detail: 'zone' });
    }
    for (const i of scene.items) {
      this.items.set(i.id, i);
      add({ key: `item:${i.id}`, kind: 'item', id: i.id, class: i.locked ? 'locked_fitting' : 'item', ...(i.roomId ? { roomId: i.roomId } : {}), ...(i.product?.name ? { detail: i.product.name } : {}) });
    }
    for (const l of scene.lights) add({ key: `light:${l.id}`, kind: 'light', id: l.id, class: 'light_fixture', ...(l.roomId ? { roomId: l.roomId } : {}) });
    // Stable colours: the sorted keys numbered from 1.
    for (const key of [...this.entities.keys()].sort()) this.colors.set(key, entityColor(this.next++));
  }

  /** The entity for `key`; unknown keys (a mesh the scene does not list) are registered on first use. */
  entity(key: string, fallback: Omit<Entity, 'key'>): Entity {
    let e = this.entities.get(key);
    if (!e) {
      e = { key, ...fallback };
      this.entities.set(key, e);
    }
    return e;
  }

  colorOf(key: string): [number, number, number] {
    let c = this.colors.get(key);
    if (!c) {
      c = entityColor(this.next++);
      this.colors.set(key, c);
    }
    return c;
  }

  item(id: string): Item | undefined {
    return this.items.get(id);
  }

  /** Entity of an item (any id): its class says locked or not. */
  itemEntity(id: string): Entity {
    return this.entity(`item:${id}`, { kind: 'item', id, class: this.items.get(id)?.locked ? 'locked_fitting' : 'item' });
  }

  lightEntity(id: string): Entity {
    return this.entity(`light:${id}`, { kind: 'light', id, class: 'light_fixture' });
  }

  contextEntity(): Entity {
    return this.entity('context', { kind: 'context', id: 'context', class: 'context' });
  }

  /** Entity of a triangle range of a shell mesh (`walls`, `floors`, `ceilings`, `fittings`, `glass`, `items`). */
  ofOwner(meshName: string, o: Pick<Owner, 'kind' | 'entityId' | 'zoneId'>): Entity {
    switch (o.kind) {
      case 'wall':
        return this.entity(`wall:${o.entityId}`, { kind: 'wall', id: o.entityId, class: 'wall' });
      case 'opening': {
        const e = this.entity(`opening:${o.entityId}`, { kind: 'opening', id: o.entityId, class: this.openings.get(o.entityId)?.type === 'window' ? 'window' : 'door' });
        // Every glazed pane is glazing, even the glass of a balcony door.
        return meshName === 'glass' ? { ...e, class: 'window' } : e;
      }
      case 'floor':
        return o.zoneId ? this.entity(`floor:${o.entityId}/${o.zoneId}`, { kind: 'floor', id: `${o.entityId}/${o.zoneId}`, class: 'floor', roomId: o.entityId }) : this.entity(`floor:${o.entityId}`, { kind: 'floor', id: o.entityId, class: 'floor', roomId: o.entityId });
      case 'ceiling':
        return this.entity(`ceiling:${o.entityId}`, { kind: 'ceiling', id: o.entityId, class: 'ceiling', roomId: o.entityId });
      case 'item':
        return this.itemEntity(o.entityId);
      case 'context':
        return this.contextEntity();
    }
  }
}

/** Instance legend from per-colour pixel counts (`counts`: packed RGB to pixels), entities in key order. */
export function buildLegend(index: SceneIndex, counts: ReadonlyMap<number, number>): LegendEntry[] {
  const out: LegendEntry[] = [];
  for (const key of [...index.entities.keys()].sort()) {
    const e = index.entities.get(key)!;
    const color = index.colorOf(key);
    const pixels = counts.get(packRgb(color)) ?? 0;
    if (pixels === 0) continue;
    out.push({ color, hex: hex(color), class: e.class, kind: e.kind, id: e.id, ...(e.roomId ? { roomId: e.roomId } : {}), ...(e.detail ? { detail: e.detail } : {}), pixels });
  }
  return out;
}

export function buildClassLegend(counts: ReadonlyMap<number, number>): ClassLegendEntry[] {
  return PASS_CLASSES.map((c) => {
    const color = [...CLASS_COLORS[c]] as [number, number, number];
    return { class: c, color, hex: hex(color), pixels: counts.get(packRgb(color)) ?? 0 };
  });
}
