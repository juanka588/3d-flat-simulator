import { describe, expect, it } from 'vitest';
import {
  GAMEPAD_DEADZONE,
  LOOK_KEYS,
  LOOK_REST,
  MAX_PITCH_RAD,
  MOVE_KEYS,
  applyDeadzone,
  arrowsBelongToItem,
  clampPitch,
  gamepadSticks,
  layoutFromMap,
  lookKeyLabel,
  readSticks,
  stepLook,
  stickFromKeys,
} from './camera-input';

const held = (...codes: string[]) => new Set(codes);

describe('key mapping (KeyboardEvent.code, layout independent)', () => {
  it('the physical W/A/S/D keys are the right stick; the AZERTY keys labelled Z/Q/S/D report the same codes', () => {
    // AZERTY: the key labelled Z reports code KeyW (key "z"), Q -> KeyA, S -> KeyS, D -> KeyD. Only `code` is read.
    const azerty = [
      { key: 'z', code: 'KeyW' },
      { key: 'q', code: 'KeyA' },
      { key: 's', code: 'KeyS' },
      { key: 'd', code: 'KeyD' },
    ];
    const qwerty = [
      { key: 'w', code: 'KeyW' },
      { key: 'a', code: 'KeyA' },
      { key: 's', code: 'KeyS' },
      { key: 'd', code: 'KeyD' },
    ];
    for (let i = 0; i < 4; i++) {
      expect(readSticks(held(azerty[i]!.code)).look).toEqual(readSticks(held(qwerty[i]!.code)).look);
    }
    expect(readSticks(held('KeyW')).look).toEqual([0, 1]);
    expect(readSticks(held('KeyS')).look).toEqual([0, -1]);
    expect(readSticks(held('KeyA')).look).toEqual([-1, 0]);
    expect(readSticks(held('KeyD')).look).toEqual([1, 0]);
    expect(Object.keys(LOOK_KEYS).sort()).toEqual(['KeyA', 'KeyD', 'KeyS', 'KeyW']);
  });

  it('the arrows are the left stick and do not look; the look keys do not move', () => {
    expect(readSticks(held('ArrowUp')).move).toEqual([0, 1]);
    expect(readSticks(held('ArrowLeft')).move).toEqual([-1, 0]);
    expect(readSticks(held('ArrowUp')).look).toEqual([0, 0]);
    expect(readSticks(held('KeyW')).move).toEqual([0, 0]);
    expect(Object.keys(MOVE_KEYS).sort()).toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
  });

  it('opposite keys cancel and diagonals are not faster', () => {
    expect(stickFromKeys(held('ArrowLeft', 'ArrowRight'), MOVE_KEYS)).toEqual([0, 0]);
    const [x, y] = stickFromKeys(held('ArrowUp', 'ArrowRight'), MOVE_KEYS);
    expect(Math.hypot(x, y)).toBeCloseTo(1, 9);
  });

  it('the arrows can be handed to a selected item (precedence: item first, otherwise the camera)', () => {
    expect(readSticks(held('ArrowUp', 'KeyD'), null, { arrows: false })).toEqual({ move: [0, 0], look: [1, 0] });
    expect(arrowsBelongToItem('orbit', { kind: 'item' })).toBe(true);
    expect(arrowsBelongToItem('top', { kind: 'item' })).toBe(true);
    expect(arrowsBelongToItem('orbit', { kind: 'wall' })).toBe(false);
    expect(arrowsBelongToItem('orbit', null)).toBe(false);
    expect(arrowsBelongToItem('walk', { kind: 'item' })).toBe(false);
  });
});

describe('look integration', () => {
  const run = (look: [number, number], seconds: number, dt = 1 / 60) => {
    let s = LOOK_REST;
    let yaw = 0;
    let pitch = 0;
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      const r = stepLook(s, look, dt);
      s = r.state;
      yaw += r.dYaw;
      pitch += r.dPitch;
    }
    return { s, yaw, pitch };
  };
  it('reaches 90 deg/s with a smooth ramp', () => {
    const first = stepLook(LOOK_REST, [1, 0], 1 / 60);
    expect(first.state.yawVel).toBeGreaterThan(0);
    expect(first.state.yawVel).toBeLessThan((90 * Math.PI) / 180 / 4);
    const r = run([1, 0], 2);
    expect(r.s.yawVel).toBeCloseTo((90 * Math.PI) / 180, 6);
    // 2 s: 0.25 s of ramp (half the distance of full speed) + 1.75 s at full speed
    expect((r.yaw * 180) / Math.PI).toBeCloseTo(90 * 1.75 + 90 * 0.125, 0);
  });
  it('eases back to rest after release', () => {
    let s = run([0, 1], 1).s;
    for (let i = 0; i < 60; i++) s = stepLook(s, [0, 0], 1 / 60).state;
    expect(s.pitchVel).toBe(0);
  });
  it('barely depends on the frame rate', () => {
    expect(run([1, 0], 1, 1 / 30).yaw).toBeCloseTo(run([1, 0], 1, 1 / 120).yaw, 1);
  });
  it('clamps the pitch to +-80 degrees', () => {
    expect(clampPitch(10)).toBeCloseTo(MAX_PITCH_RAD, 9);
    expect(clampPitch(-10)).toBeCloseTo(-MAX_PITCH_RAD, 9);
    expect((MAX_PITCH_RAD * 180) / Math.PI).toBeCloseTo(80, 9);
    expect(clampPitch(0.3)).toBe(0.3);
  });
});

describe('gamepad', () => {
  it('ignores stick noise inside the deadzone and rescales outside it', () => {
    expect(applyDeadzone([0.1, 0.1])).toEqual([0, 0]);
    expect(applyDeadzone([GAMEPAD_DEADZONE, 0])).toEqual([0, 0]);
    expect(applyDeadzone([1, 0])[0]).toBeCloseTo(1, 9);
    expect(applyDeadzone([0.575, 0])[0]).toBeCloseTo(0.5, 9);
  });
  it('left stick moves, right stick looks, up is positive', () => {
    const s = gamepadSticks({ axes: [0, -1, 1, 0] });
    expect(s.move[1]).toBeCloseTo(1, 9);
    expect(s.move[0]).toBeCloseTo(0, 9);
    expect(s.look[0]).toBeCloseTo(1, 9);
    expect(gamepadSticks({ axes: [0.05, 0.05, -0.1, 0.1] })).toEqual({ move: [0, 0], look: [0, 0] });
    expect(gamepadSticks(null)).toEqual({ move: [0, 0], look: [0, 0] });
    expect(gamepadSticks({ axes: [] })).toEqual({ move: [0, 0], look: [0, 0] });
  });
  it('the keyboard wins where it is pushed, the pad fills the rest', () => {
    const s = readSticks(held('KeyD'), { axes: [0, -1, 0, 0] });
    expect(s.look).toEqual([1, 0]);
    expect(s.move[1]).toBeCloseTo(1, 9);
  });
});

describe('keyboard layout help', () => {
  it('detects AZERTY from the layout map and shows both labels when unknown', () => {
    expect(layoutFromMap(new Map([['KeyW', 'z']]))).toBe('azerty');
    expect(layoutFromMap(new Map([['KeyW', 'w']]))).toBe('other');
    expect(layoutFromMap(undefined)).toBe('unknown');
    expect(lookKeyLabel('azerty')).toBe('ZQSD');
    expect(lookKeyLabel('other')).toBe('WASD');
    expect(lookKeyLabel('unknown')).toBe('ZQSD / WASD');
  });
});
