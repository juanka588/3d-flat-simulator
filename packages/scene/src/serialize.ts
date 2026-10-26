import type { Scene } from './schema';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/**
 * Serialises a scene to `.flat.json` text. Byte-stable: object keys are sorted recursively
 * (array order is data and is kept), 2-space indent, trailing newline, `undefined` fields dropped.
 * `loadSceneText(serializeScene(s))` yields a scene that serialises to the same bytes.
 */
export function serializeScene(scene: Scene): string {
  return `${JSON.stringify(canonical(scene), null, 2)}\n`;
}
