import type { MeshData } from '@flat/scene';
import { MATTRESS_THICKNESS, type BedDressingSpec } from '@flat/scene';
import { Kit } from '../generators/kit';
import { ITEM_MATERIALS } from '../materials/item-materials';

/** Mattress, duvet and pillows in the item frame (head at the back, -z). */
export function buildBedDressing(spec: BedDressingSpec): MeshData {
  const { mattress: m, frame, slatTop } = spec;
  const kit = new Kit();
  const x0 = -m.w / 2;
  const x1 = m.w / 2;
  // Foot flush with the frame, head against the headboard.
  const z1 = frame.d / 2;
  const z0 = z1 - m.d;
  const top = slatTop + MATTRESS_THICKNESS;
  kit.box(ITEM_MATERIALS.whiteMatte, x0, slatTop, z0, x1, top, z1, 0.03);
  // Duvet: over the lower two thirds, hanging 12 cm down the sides and the foot (inside the frame footprint).
  const dz0 = z0 + m.d * 0.34;
  const duvetT = 0.07;
  const over = 0.02;
  kit.box(ITEM_MATERIALS.bedding, x0 - over, top, dz0, x1 + over, top + duvetT, z1, 0.03);
  const drop = 0.12;
  kit.box(ITEM_MATERIALS.bedding, x0 - over, top - drop, dz0, x0, top, z1, 0.015);
  kit.box(ITEM_MATERIALS.bedding, x1, top - drop, dz0, x1 + over, top, z1, 0.015);
  kit.box(ITEM_MATERIALS.bedding, x0 - over, top - drop, z1 - over, x1 + over, top, z1, 0.015);
  // Pillows against the headboard.
  const pillows = m.w >= 1.3 ? 2 : 1;
  const pw = Math.min(0.62, (m.w - 0.1) / pillows - 0.04);
  for (let i = 0; i < pillows; i++) {
    const cx = ((i + 0.5) / pillows - 0.5) * m.w;
    kit.box(ITEM_MATERIALS.whiteMatte, cx - pw / 2, top, z0 + 0.04, cx + pw / 2, top + 0.13, z0 + 0.04 + 0.4, 0.04);
  }
  return kit.build();
}
