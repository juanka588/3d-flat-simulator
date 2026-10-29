import { beforeEach, describe, expect, it } from 'vitest';
import { referenceBudget, resetReferenceClock } from './reference';

const env = { FLAT_REFERENCE_BUDGET_S: '1000' };
beforeEach(() => resetReferenceClock());

describe('reference phase time budget', () => {
  it('does nothing without a budget', () => {
    expect(referenceBudget(2, {}, 0)).toEqual({ n: 2 });
  });

  it('cuts candidates to one after 40% of the budget and refuses new references after all of it', () => {
    expect(referenceBudget(2, env, 0)).toEqual({ n: 2 }); // starts the clock
    expect(referenceBudget(2, env, 300_000)).toEqual({ n: 2 });
    const cut = referenceBudget(2, env, 450_000);
    expect(cut.n).toBe(1);
    expect(cut.note).toMatch(/reduced to 1/);
    expect(referenceBudget(1, env, 450_000)).toEqual({ n: 1 });
    expect(referenceBudget(2, env, 1_000_000).refuse).toMatch(/budget .* is used up/);
  });
});
