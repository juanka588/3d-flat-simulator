import { GENERATORS } from '@flat/scene';
import type { GeneratorRegistry } from '@flat/scene';
import { ALL_GENERATORS } from './generators';

/** Registers every generator in `registry` (default: the process-wide `GENERATORS` of @flat/scene). Idempotent. */
export function registerGenerators(registry: GeneratorRegistry = GENERATORS): void {
  for (const g of ALL_GENERATORS) if (!registry.get(g.id)) registry.register(g);
}

/**
 * Throws if the process-wide registry is not complete. Scene no longer registers the generators (it only holds the empty
 * registry), so every app entry imports `@flat/assets` and calls this at start-up: otherwise the scene schema would skip
 * the params check of parametric items and accept invalid ones (docs/architecture/modules.md section 6, first risk).
 */
export function assertGeneratorsRegistered(registry: GeneratorRegistry = GENERATORS): void {
  const missing = ALL_GENERATORS.filter((g) => !registry.get(g.id)).map((g) => g.id);
  if (missing.length > 0) {
    throw new Error(`@flat/assets: generators not registered in scene's GENERATORS (${missing.join(', ')}); import '@flat/assets' in the app entry.`);
  }
}

// Side effect: importing the package index runs this, so parsing a scene with a parametric mesh checks its params and
// dims against the generator.
registerGenerators();
