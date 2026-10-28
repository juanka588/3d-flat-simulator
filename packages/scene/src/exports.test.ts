import { describe, expect, it } from 'vitest';
import * as scene from './index';

// Public runtime surface of @flat/scene (docs/architecture/modules.md). Recorded in step 0 as the refactor baseline; step A4
// removed exactly the 50 asset and product-wire names that moved to @flat/assets (see the "Step A4 record"). Types are erased
// and are covered by `tsc`. A deliberate API change updates the snapshot (`vitest -u`) in the same commit.
describe('@flat/scene export snapshot', () => {
  it('exposes the same runtime names', () => {
    expect(Object.keys(scene).sort()).toMatchSnapshot();
  });
});
