import { describe, expect, it } from 'vitest';
import * as scene from './index';

// Public runtime surface of @flat/scene (docs/architecture/modules.md step A1: "the root barrel exports exactly the same
// names"). Recorded in step 0 as the refactor baseline. Types are erased and are covered by `tsc`. A deliberate API change
// updates the snapshot (`vitest -u`) in the same commit; the module split must NOT change it until A4 moves the asset code.
describe('@flat/scene export snapshot', () => {
  it('exposes the same runtime names', () => {
    expect(Object.keys(scene).sort()).toMatchSnapshot();
  });
});
