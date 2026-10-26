import { expect, it } from 'vitest';
import { newId } from './ids';

it('makes 26-char Crockford ids that are strictly increasing, even within a millisecond', () => {
  const ids = Array.from({ length: 500 }, () => newId(1_700_000_000_000));
  for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(ids);
});

it('sorts by time across milliseconds', () => {
  const a = newId(1_800_000_000_000);
  const b = newId(1_800_000_000_001);
  expect(a < b).toBe(true);
});
