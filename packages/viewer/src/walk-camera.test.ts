import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERSON_HEIGHT_CM,
  MAX_PERSON_HEIGHT_CM,
  MAX_VERTICAL_FOV_DEG,
  MIN_PERSON_HEIGHT_CM,
  clampPersonHeightCm,
  eyeHeightM,
  horizontalFovDeg,
  walkFovDeg,
} from './walk-camera';

describe('eyeHeightM', () => {
  it('is the height minus 11 cm', () => {
    expect(eyeHeightM(166)).toBe(1.55);
    expect(eyeHeightM(180)).toBe(1.69);
    expect(eyeHeightM(120)).toBe(1.09);
  });
  it('clamps absurd heights', () => {
    expect(eyeHeightM(40)).toBe(eyeHeightM(MIN_PERSON_HEIGHT_CM));
    expect(eyeHeightM(900)).toBe(eyeHeightM(MAX_PERSON_HEIGHT_CM));
    expect(eyeHeightM(Number.NaN)).toBe(1.55);
  });
});

describe('clampPersonHeightCm', () => {
  it('rounds to whole centimetres and clamps', () => {
    expect(clampPersonHeightCm(165.6)).toBe(166);
    expect(clampPersonHeightCm(10)).toBe(MIN_PERSON_HEIGHT_CM);
    expect(clampPersonHeightCm(500)).toBe(MAX_PERSON_HEIGHT_CM);
    expect(clampPersonHeightCm(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PERSON_HEIGHT_CM);
  });
});

describe('walkFovDeg', () => {
  it('is 60 degrees vertical on landscape and square screens', () => {
    expect(walkFovDeg(16 / 10)).toBe(60);
    expect(walkFovDeg(1)).toBe(60);
    expect(walkFovDeg(21 / 9)).toBe(60);
  });
  it('falls back to the landscape fov for nonsense aspects', () => {
    expect(walkFovDeg(0)).toBe(60);
    expect(walkFovDeg(Number.NaN)).toBe(60);
    expect(walkFovDeg(-2)).toBe(60);
  });
  it('gives about 75 degrees horizontal on a moderately tall portrait screen', () => {
    const aspect = 0.75; // a tablet
    const v = walkFovDeg(aspect);
    expect(v).toBeGreaterThan(50);
    expect(horizontalFovDeg(v, aspect)).toBeCloseTo(75, 5);
  });
  it('caps the vertical fov on a tall phone', () => {
    const aspect = 390 / 844;
    expect(walkFovDeg(aspect)).toBe(MAX_VERTICAL_FOV_DEG);
    // Still much wider than the 50 degree keyhole (~25 degrees across) it would be otherwise.
    expect(horizontalFovDeg(walkFovDeg(aspect), aspect)).toBeGreaterThan(55);
  });
  it('widens monotonically as the screen gets taller', () => {
    let prev = walkFovDeg(0.99);
    for (const a of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      const v = walkFovDeg(a);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
