/**
 * State assertions shared by the LLM demos (API-driven `llm-demo.mjs` and `claude-cli-demo.mjs`): they look at
 * the scene server's state and history, never at the model's prose.
 */

export const PROMPT_SAGE = 'Paint the séjour sage green, give the flat warm 2700K evening lighting, and show me.';
export const PROMPT_NEGATIVE = 'Remove the wall between the séjour and the hall.';

export function hueOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null; // grey: no hue
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

export const wallKey = (w) => JSON.stringify([w.id, w.start, w.end, w.thickness, w.height, w.structural ?? null]);

/** Mean colour of a material id: the scene's own (paint colour) or the texture catalog's `meanColor`. */
export function colorOfMaterial(scene, catalog, id) {
  if (!id) return undefined;
  const own = scene.materials?.find((m) => m.id === id)?.color;
  if (own) return own;
  const list = Array.isArray(catalog) ? catalog : (catalog?.materials ?? []);
  return list.find((m) => m.id === id)?.meanColor;
}

/** Baseline authored by the user, not the model: every lamp off and cold, so "warm 2700K and on" is something the model had to do. */
export async function applyBaseline(flat) {
  const start = await flat.get('/api/scene');
  const setup = start.scene.lights.map((l) => ({ type: 'light.update', id: l.id, patch: { on: false, kelvin: 4000 } }));
  await flat.post('/api/commands', { v: 1, id: `demo-setup-${Date.now()}`, ts: Date.now(), author: { kind: 'user' }, cmd: { type: 'batch', label: 'demo baseline', commands: setup } });
  const before = await flat.get('/api/scene');
  const historyBefore = (await flat.get('/api/history')).past.length;
  return { before, historyBefore };
}

/**
 * Runs the assertions.
 * @param {object} p
 * @param {(ok: boolean, what: string, detail?: string) => void} p.check
 * @param {{get: Function}} p.flat REST client of the scene server
 * @param {(roomId: string) => Promise<any>} p.describeRoom the MCP `describe_room` result (structured)
 * @param {object} p.before `/api/scene` right after the baseline
 * @param {number} p.historyBefore
 * @param {{name: string, input: any, image: boolean, error: boolean}[]} p.calls tool calls in order (`name` without any prefix)
 * @param {string | undefined} p.lastImage base64 of the last image a tool returned
 * @param {string} p.finalPng where it was saved
 * @param {boolean} p.negative
 */
export async function assertDemoState({ check, flat, describeRoom, before, historyBefore, calls, lastImage, finalPng, negative }) {
  const after = await flat.get('/api/scene');
  const history = await flat.get('/api/history');
  const beforeWalls = new Map(before.scene.walls.map((w) => [w.id, wallKey(w)]));
  const wallsSame = after.scene.walls.length === before.scene.walls.length && after.scene.walls.every((w) => beforeWalls.get(w.id) === wallKey(w));
  check(wallsSame, 'no structural wall changed or was removed (walls identical: ids, geometry, structural flags)');

  const mine = history.past.slice(historyBefore);
  check(mine.every((h) => h.author?.kind === 'llm'), 'every history entry after the baseline is authored by llm', `${mine.length} entries, authors: ${[...new Set(mine.map((h) => h.author?.kind))].join(',') || 'none'}`);

  if (negative) {
    check(mine.length === 0 || mine.every((h) => !/wall/i.test(h.label)), 'no wall-related change in the history', mine.map((h) => h.label).join(' | '));
    check(after.scene.walls.length === before.scene.walls.length, 'the wall count is unchanged');
    return;
  }

  check(mine.length >= 1, 'the model changed the flat (at least one history entry)');

  // "Sage séjour": every wall face of the room resolves (floor-to-ceiling effective material, whatever the way it
  // was painted: room finish, whole-face or room-scoped wall finish) to a greenish colour.
  const catalog = await flat.get('/api/materials').catch(() => []);
  const room = await describeRoom('sejour');
  const faces = room?.walls ?? [];
  const detail = faces.map((w) => {
    const color = colorOfMaterial(after.scene, catalog, w.finish?.materialId);
    const hue = hueOf(color);
    return { wall: `${w.wallId}/${w.side}`, material: w.finish?.materialId ?? 'none', color: color ?? '?', hue: hue === null ? null : Math.round(hue) };
  });
  const greenish = (d) => d.hue !== null && d.hue >= 70 && d.hue <= 150;
  check(faces.length > 0 && detail.every(greenish), 'every wall face of the séjour resolves to a greenish colour (hue 70-150)', detail.map((d) => `${d.wall}=${d.material}:${d.color}:${d.hue ?? 'n/a'}`).join(' '));

  // Warm lamps: in the scene (state), or - if the model chose to show it only in the picture - in a render's `lamps` override.
  const warm = after.scene.lights.filter((l) => l.kelvin === 2700 && l.on !== false);
  const rendered = calls.filter((c) => c.image && !c.error && c.input && typeof c.input === 'object');
  const renderOnlyWarm = rendered.some((c) => Object.values(c.input.lamps ?? c.input.render?.lamps ?? {}).some((l) => l && l.kelvin === 2700 && l.on !== false));
  check(warm.length >= 1 || renderOnlyWarm, 'warm 2700K light: at least one light is 2700 K and on in the scene, or a render showed it with a lamps override', warm.length ? warm.map((l) => l.id).join(',') : renderOnlyWarm ? 'render-only (lamps override)' : 'none');

  // A render came back: render_view, or a write tool called with `render` (which returns the image too).
  const withImage = calls.filter((c) => c.image && !c.error);
  check(withImage.length >= 1, 'a render with an image was returned (render_view, or a write tool with render)', withImage.map((c) => c.name).join(','));
  check(Boolean(lastImage), 'the final render was saved', finalPng);
}
