import { describe, expect, it } from 'vitest';
import { CommandEnvelope, type Scene } from '@flat/scene';
import { CaptureAnchor, CaptureAsset, Observation, observationsToCommands } from './index';

describe('CaptureAsset', () => {
  it('accepts a photo with EXIF time, GPS and intrinsics', () => {
    const a = { id: 'a1', kind: 'photo', mime: 'image/heic', takenAt: '2026-01-02T10:00:00+01:00', gps: { lat: 48.85, lon: 2.35 }, intrinsics: { widthPx: 4000, heightPx: 3000, fxPx: 3000, fyPx: 3000, cxPx: 2000, cyPx: 1500 } };
    expect(CaptureAsset.parse(a)).toEqual(a);
  });
  it('rejects bad kind, mime, GPS range and unknown keys', () => {
    expect(CaptureAsset.safeParse({ id: 'a', kind: 'audio', mime: 'image/jpeg' }).success).toBe(false);
    expect(CaptureAsset.safeParse({ id: 'a', kind: 'photo', mime: 'jpeg' }).success).toBe(false);
    expect(CaptureAsset.safeParse({ id: 'a', kind: 'photo', mime: 'image/jpeg', gps: { lat: 91, lon: 0 } }).success).toBe(false);
    expect(CaptureAsset.safeParse({ id: 'a', kind: 'scan', mime: 'model/gltf-binary', extra: 1 }).success).toBe(false);
  });
});

describe('CaptureAnchor', () => {
  it('requires a finite pose', () => {
    expect(CaptureAnchor.safeParse({ assetId: 'a', position: { x: 1, y: 1.5, z: 2 }, yaw: 0.3 }).success).toBe(true);
    expect(CaptureAnchor.safeParse({ assetId: 'a', position: { x: 1, y: 1.5, z: 2 }, yaw: Infinity }).success).toBe(false);
  });
});

describe('Observation', () => {
  const ok = [
    { id: 'o1', type: 'distance', metres: 2.4 },
    { id: 'o2', type: 'colour', target: { surface: 'wall', roomId: 'r1', side: 'left' }, hex: '#aabbcc' },
    { id: 'o3', type: 'colour', target: { surface: 'floor', roomId: 'r1' }, hex: '#AABBCC' },
    { id: 'o4', type: 'opening', kind: 'window', widthM: 1.2, heightM: 1.1, offsetM: 0.5 },
    { id: 'o5', type: 'item', label: 'sofa', dims: { w: 2, d: 0.9, h: 0.8 } },
  ];
  it.each(ok.map((o) => [o.id, o] as const))('accepts %s', (_id, o) => {
    expect(Observation.safeParse(o).success).toBe(true);
  });
  it('rejects invalid observations', () => {
    expect(Observation.safeParse({ id: 'x', type: 'distance', metres: -1 }).success).toBe(false);
    expect(Observation.safeParse({ id: 'x', type: 'colour', target: { surface: 'ceiling', roomId: 'r' }, hex: '#000000' }).success).toBe(false);
    expect(Observation.safeParse({ id: 'x', type: 'colour', target: { surface: 'floor', roomId: 'r' }, hex: 'red' }).success).toBe(false);
    expect(Observation.safeParse({ id: 'x', type: 'item', label: 's', dims: { w: 1, d: 0, h: 1 } }).success).toBe(false);
    expect(Observation.safeParse({ id: 'x', type: 'teleport' }).success).toBe(false);
  });
});

describe('observationsToCommands', () => {
  // The function only reads `rooms`; a full Scene is not needed.
  const scene = { rooms: [{ id: 'r1' }] } as unknown as Scene;
  const obs = [
    Observation.parse({ id: 'c1', type: 'colour', target: { surface: 'wall', roomId: 'r1' }, hex: '#ffffff', materialId: 'm1' }),
    Observation.parse({ id: 'c2', type: 'colour', target: { surface: 'wall', roomId: 'nope' }, hex: '#ffffff', materialId: 'm1' }),
    Observation.parse({ id: 'd1', type: 'distance', metres: 3 }),
  ];
  it('proposes planner-authored, schema-valid room.setWallFinish and does not mutate the scene', () => {
    const before = JSON.stringify(scene);
    const cmds = observationsToCommands(scene, obs, { ts: 1 });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.author.kind).toBe('planner');
    expect(cmds[0]!.cmd).toEqual({ type: 'room.setWallFinish', roomId: 'r1', materialId: 'm1' });
    expect(CommandEnvelope.safeParse(cmds[0]).success).toBe(true);
    expect(JSON.stringify(scene)).toBe(before);
  });
});
