import { describe, expect, it } from 'vitest';
import { northNeedleAngle } from './Compass';

describe('northNeedleAngle', () => {
  it('points up when facing north with northAngle 0 (plan up = north)', () => {
    expect(northNeedleAngle([0, -1], 0)).toBeCloseTo(0);
  });
  it('points right when facing plan-up and north is clockwise 90 degrees (plan +x)', () => {
    expect(northNeedleAngle([0, -1], 90)).toBeCloseTo(90);
  });
  it('turns opposite to the camera', () => {
    // Facing plan +x (east on the plan): north (plan up) is on the left.
    expect(northNeedleAngle([1, 0], 0)).toBeCloseTo(-90);
  });
});
