import { itemDims, type CameraPose, type Item, type Opening, type Scene, type Vec2, type WalkPose } from '@flat/scene';
import { headingOf, itemVisibility, roomEdges, roomWindowless } from './views';

/**
 * What the picture of a view must contain, read from the scene (reference prompt v2, from the restyle spike): the openings the
 * camera sees (count, side, size) and the fixed fittings in view. A model told only "a Parisian living room" invents windows and
 * doors; one told "exactly 3 openings: ..." keeps them. Pure: the same scene and pose give the same text.
 */

export type Side = 'LEFT' | 'CENTRE' | 'RIGHT';

export interface FactOpening {
  id: string;
  kind: 'window' | 'glazed door' | 'door' | 'passage';
  side: Side;
  foreground: boolean;
  /** Reads like "one glazed double balcony door, 1.40 x 2.05 m, two sashes, floor-level sill". */
  text: string;
  /** Lets daylight in (a window or a glazed door). */
  light: boolean;
}

export interface FactFitting {
  id: string;
  side: Side;
  /** Every side it is seen on when there are several (a run of wall units). */
  sides?: Side[];
  text: string;
}

export interface ViewFacts {
  openings: FactOpening[];
  fittings: FactFitting[];
  /** No window or glazed door in the picture (a bathroom or a WC seen from its door; a living view that looks away from the balcony doors). */
  windowless: boolean;
  /** The room has no window or glazed door at all (sdb, WC, entrance hall): its light is artificial. */
  roomWindowless: boolean;
  /** "Openings (keep exactly): ..." as lines for the prompt (no ids). */
  openingsText: string;
  /** "Fixed fittings (keep, same place and size): ..." */
  fittingsText: string;
}

const m = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const bearing = (pose: WalkPose, p: Vec2): number => ((headingOf([p[0] - pose.position[0], p[1] - pose.position[1]]) - pose.headingDeg + 540) % 360) - 180;
const sideOf = (b: number, fov: number): Side => (b < -fov * 0.17 ? 'LEFT' : b > fov * 0.17 ? 'RIGHT' : 'CENTRE');

function openingText(o: Opening, toBalcony: boolean): { kind: FactOpening['kind']; text: string; light: boolean } {
  const size = `${m(o.width)} x ${m(o.height)} m`;
  const glazed = o.glazed ?? o.type === 'window';
  const sashes = o.sashes ?? (o.width > 1.1 ? 2 : 1);
  const sash = sashes === 1 ? 'a single sash' : sashes === 2 ? 'two sashes' : `${sashes} sashes`;
  if (o.type === 'window') return { kind: 'window', text: `one window, ${size}, ${sash}, sill ${m(o.sill)} m above the floor`, light: true };
  if (o.type === 'passage') return { kind: 'passage', text: `one open passage without a door leaf, ${size}`, light: false };
  if (glazed) return { kind: 'glazed door', text: `one glazed ${toBalcony ? 'balcony ' : ''}${sashes === 2 ? 'double ' : ''}door, ${size}, ${sash}, floor-level sill`, light: true };
  return { kind: 'door', text: `one plain ${o.finish === 'white' ? 'white ' : ''}interior door, ${size}`, light: false };
}

/** How a fixed fitting reads in the prompt (by generator, then by id), or undefined when it is not worth a word (tiles, trims). */
const PLURAL: Record<string, string> = {
  'a tall oven or larder column': 'tall oven or larder columns',
  'a white panel radiator low on the wall': 'white panel radiators low on the wall',
  'wall units': 'wall units',
};

function fittingWords(i: Item): string | undefined {
  const g = i.mesh && 'generator' in i.mesh ? String(i.mesh.generator) : i.assetId.replace(/^(param|builtin):/, '');
  const d = itemDims(i);
  const w = `${m(d.w)} m wide`;
  const id = i.id;
  if (/tiles|trim/i.test(g)) return undefined;
  if (/^tv/i.test(g)) return 'one 55 inch TV on the wall';
  if (g === 'radiator') return d.h > 1 ? 'a slim white towel radiator on the wall' : 'a white panel radiator low on the wall';
  if (g === 'wardrobe') return /panel|^te-/i.test(id) ? 'a narrow cupboard door (electrical panel)' : `a built-in wardrobe with flat doors (${w})`;
  if (g === 'cooktop') return 'a black induction hob in the worktop';
  if (g === 'washbasin') return /sink|kitchen/i.test(id) ? 'a black sink in the worktop' : `a light-oak vanity with a white basin (${w})`;
  if (g === 'fridge') return 'a tall stainless fridge';
  if (g === 'kitchenWall') return 'wall units';
  if (g === 'kitchenBase') return d.w < 0.1 ? undefined : 'base units';
  if (g === 'ovenColumn') return 'a tall oven or larder column';
  if (g === 'bathtub') return `a bathtub (${w})`;
  if (g === 'bathScreen') return 'a clear glass bath screen at the tap end of the bath';
  if (g === 'washingMachine') return 'a washing machine under a white worktop';
  if (g === 'toilet') return 'one white toilet with a cistern against the wall';
  if (g === 'handBasin') return 'a small wall-hung hand basin with a chrome tap';
  if (g === 'mirror') return `a mirror on the wall (${w})`;
  if (g === 'pendant') return 'one ceiling light fitting';
  return undefined;
}

/** Facts of the picture a camera at `pose` takes of room `roomId`. */
export function viewFacts(scene: Scene, roomId: string, camera: CameraPose): ViewFacts {
  const pose = camera.mode === 'walk' ? camera : undefined;
  const room = scene.rooms.find((r) => r.id === roomId);
  const openings: FactOpening[] = [];
  if (room && pose) {
    const half = pose.fovDeg / 2 + 4;
    for (const e of roomEdges(scene, room)) {
      for (const oi of e.openings) {
        const o = scene.openings.find((x) => x.id === oi.id);
        if (!o) continue;
        const dist = Math.hypot(oi.centre[0] - pose.position[0], oi.centre[1] - pose.position[1]);
        const b = bearing(pose, oi.centre);
        // a door we stand in or beside (doorway camera) is in the picture's foreground even at the edge; one behind us is not
        const foreground = dist < 1.3 && Math.abs(b) <= 100;
        if (!foreground && Math.abs(b) > half) continue;
        const t = openingText(o, oi.otherType === 'balcony');
        openings.push({ id: o.id, kind: t.kind, text: t.text, light: t.light, side: sideOf(b, pose.fovDeg), foreground });
      }
    }
  }
  openings.sort((a, b) => ['LEFT', 'CENTRE', 'RIGHT'].indexOf(a.side) - ['LEFT', 'CENTRE', 'RIGHT'].indexOf(b.side));

  const fittings: FactFitting[] = [];
  if (room && pose) {
    const seen = new Map<string, { id: string; text: string; sides: Side[]; n: number }>();
    for (const i of scene.items) {
      if (!(i.locked || /^builtin:tv/.test(i.assetId))) continue;
      const words = fittingWords(i);
      if (!words) continue;
      const inRoom = i.roomId === undefined || i.roomId === room.id;
      if (!inRoom || itemVisibility(scene, pose, i) < 0.4) continue;
      const side = sideOf(bearing(pose, [i.position[0], i.position[1]]), pose.fovDeg);
      const prev = seen.get(words);
      if (prev) {
        prev.n++;
        if (!prev.sides.includes(side)) prev.sides.push(side);
      } else seen.set(words, { id: i.id, text: words, sides: [side], n: 1 });
    }
    for (const f of seen.values()) {
      const order = ['LEFT', 'CENTRE', 'RIGHT'];
      const sides = [...f.sides].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      fittings.push({ id: f.id, side: sides[0]!, text: f.n > 1 && !/^wall units$/.test(f.text) ? (PLURAL[f.text] ? `${f.n} ${PLURAL[f.text]}` : `${f.n} x ${f.text}`) : f.text, ...(sides.length > 1 ? { sides } : {}) });
    }
  }

  const light = openings.filter((o) => o.light).length;
  const windowless = light === 0;
  const roomIsWindowless = room ? roomWindowless(scene, roomId) : false;
  const count = (k: FactOpening['kind']) => openings.filter((o) => o.kind === k).length;
  const parts = [
    count('glazed door') ? `${count('glazed door')} glazed door${count('glazed door') > 1 ? 's' : ''}` : '',
    count('window') ? `${count('window')} window${count('window') > 1 ? 's' : ''}` : '',
    count('door') ? `${count('door')} plain door${count('door') > 1 ? 's' : ''}` : '',
    count('passage') ? `${count('passage')} open passage${count('passage') > 1 ? 's' : ''}` : '',
  ].filter(Boolean);
  const place = (o: FactOpening) => `${o.side}${o.foreground ? ' foreground' : ''}: ${o.text}`;
  const openingsText = openings.length
    ? `Openings (keep exactly, same count, place and size): ${openings.length} in total (${parts.join(', ')})${windowless ? '' : `, no other ${light ? 'window' : 'opening'}`}. ${openings.map(place).join('; ')}.`
    : 'Openings: none in the picture, only plain closed walls.';
  const fittingsText = fittings.length ? `Fixed fittings (keep, same place and size): ${fittings.map((f) => `${f.text} (${(f.sides ?? [f.side]).map((x) => x.toLowerCase()).join(' and ')})`).join('; ')}.` : '';
  return { openings, fittings, windowless, roomWindowless: roomIsWindowless, openingsText, fittingsText };
}
