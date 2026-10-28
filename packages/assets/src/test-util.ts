import { parseScene } from '@flat/scene';
import type { Scene, SceneInput } from '@flat/scene';

/** Test helper: builds a validated scene from a few walls and openings (same as scene's geometry/testUtil `makeScene`). */
export function makeScene(
  walls: SceneInput['walls'],
  openings: NonNullable<SceneInput['openings']> = [],
  extra: Partial<SceneInput> = {},
): Scene {
  const result = parseScene({
    version: 1,
    name: 'test',
    site: { latitude: 48.8, longitude: 2.3 },
    walls,
    openings,
    ...extra,
  });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.scene;
}
