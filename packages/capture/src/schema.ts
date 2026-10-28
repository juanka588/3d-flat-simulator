import { z } from 'zod';

/** Local, non-secret id of an asset/anchor/observation. */
const Id = z.string().min(1).max(64);
const Finite = z.number().finite();

/** EXIF GPS. Personal data: never persisted outside the local-only locations (see README). */
export const ExifGps = z.strictObject({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  altitudeM: Finite.optional(),
});
export type ExifGps = z.infer<typeof ExifGps>;

/** Pinhole camera intrinsics, in pixels. */
export const CameraIntrinsics = z.strictObject({
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  fxPx: z.number().positive(),
  fyPx: z.number().positive(),
  cxPx: Finite,
  cyPx: Finite,
});
export type CameraIntrinsics = z.infer<typeof CameraIntrinsics>;

export const CaptureAsset = z.strictObject({
  id: Id,
  kind: z.enum(['photo', 'video', 'scan']),
  mime: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/i, 'expected a mime type such as image/jpeg'),
  /** EXIF capture time, ISO 8601. */
  takenAt: z.iso.datetime({ offset: true }).optional(),
  gps: ExifGps.optional(),
  intrinsics: CameraIntrinsics.optional(),
});
export type CaptureAsset = z.infer<typeof CaptureAsset>;

/** Pose of a capture in Scene coordinates (metres; angles in radians). */
export const CaptureAnchor = z.strictObject({
  assetId: Id,
  position: z.strictObject({ x: Finite, y: Finite, z: Finite }),
  yaw: Finite,
  pitch: Finite.optional(),
  roll: Finite.optional(),
});
export type CaptureAnchor = z.infer<typeof CaptureAnchor>;

const Base = { id: Id, assetId: Id.optional(), confidence: z.number().min(0).max(1).optional() };
const Hex = z.string().regex(/^#[0-9a-f]{6}$/i, 'expected #rrggbb');

export const DistanceObservation = z.strictObject({
  ...Base,
  type: z.literal('distance'),
  metres: z.number().positive().finite(),
  /** Free-text description of the measured span, e.g. "window sill to floor". */
  label: z.string().max(200).optional(),
});

/** Where a colour was sampled: one side of a wall (relative to start->end, as in the Scene) or a floor. */
export const ColourTarget = z.discriminatedUnion('surface', [
  z.strictObject({ surface: z.literal('wall'), roomId: Id, wallId: Id.optional(), side: z.enum(['left', 'right']).optional() }),
  z.strictObject({ surface: z.literal('floor'), roomId: Id }),
]);
export type ColourTarget = z.infer<typeof ColourTarget>;

export const ColourObservation = z.strictObject({
  ...Base,
  type: z.literal('colour'),
  target: ColourTarget,
  hex: Hex,
  /** Scene material id the importer matched the sample to, if any. */
  materialId: Id.optional(),
});

export const OpeningObservation = z.strictObject({
  ...Base,
  type: z.literal('opening'),
  kind: z.enum(['door', 'window', 'passage']),
  widthM: z.number().positive().finite(),
  heightM: z.number().positive().finite(),
  wallId: Id.optional(),
  /** Distance along the wall from its start, metres. */
  offsetM: z.number().finite().nonnegative().optional(),
});

export const ItemObservation = z.strictObject({
  ...Base,
  type: z.literal('item'),
  label: z.string().min(1).max(200),
  dims: z.strictObject({ w: z.number().positive().finite(), d: z.number().positive().finite(), h: z.number().positive().finite() }),
  position: z.strictObject({ x: Finite, z: Finite }).optional(),
});

export const Observation = z.discriminatedUnion('type', [DistanceObservation, ColourObservation, OpeningObservation, ItemObservation]);
export type Observation = z.infer<typeof Observation>;
