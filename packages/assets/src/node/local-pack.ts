import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MeshAsset } from '../catalog/mesh-catalog';

/**
 * The local 3D-FUTURE pack (`pnpm models:local`): `catalog.json` plus `<model_id>.glb` in a gitignored folder
 * (`apps/server/local-assets/3d-future`). Research licence: served to this machine only (loopback / Origin
 * guards, `no-store`), never committed, never deployed.
 *
 * Asset ids look like `local:3dfuture:<model_id>`; the bare `<model_id>` is accepted too. A model id is
 * `[A-Za-z0-9][A-Za-z0-9_-]{0,40}` (what the import script writes), so it can never contain a dot or a slash.
 */

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const ID_PREFIX = 'local:3dfuture:';
export const LOCAL_MESH_MAX_BYTES = 20 * 1024 * 1024;

/** `local:3dfuture:abc` or `abc` -> `abc`; anything else (traversal, other namespaces, empty) -> undefined. */
export function localModelId(assetId: string): string | undefined {
  const bare = assetId.startsWith(ID_PREFIX) ? assetId.slice(ID_PREFIX.length) : assetId;
  return MODEL_ID.test(bare) ? bare : undefined;
}

/** The catalog entries the pack declares, reduced to the `MeshAsset` fields (extra build metadata such as sha256 or thumb is dropped; invalid entries are skipped). */
export async function readLocalCatalog(dir: string): Promise<MeshAsset[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: MeshAsset[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of ASSET_KEYS) if (e[k] !== undefined) picked[k] = e[k];
    const parsed = MeshAsset.safeParse(picked);
    if (parsed.success && parsed.data.source === '3dfuture' && localModelId(parsed.data.id) !== undefined) out.push(parsed.data);
  }
  return out;
}
const ASSET_KEYS = ['id', 'name', 'source', 'licence', 'credit', 'category', 'styleTags', 'nativeDims', 'anchor', 'front', 'file', 'generator'] as const;

/** Bytes of one local model, or undefined when the id is invalid, not in the catalog, or the file is missing / not a GLB / too big. */
export async function readLocalModel(dir: string, assetId: string): Promise<Uint8Array | undefined> {
  const id = localModelId(assetId);
  if (id === undefined) return undefined;
  const listed = (await readLocalCatalog(dir)).some((a) => localModelId(a.id) === id);
  if (!listed) return undefined;
  const file = join(dir, `${id}.glb`);
  try {
    const s = await lstat(file);
    if (!s.isFile() || s.size > LOCAL_MESH_MAX_BYTES || s.size < 12) return undefined;
    const bytes = await readFile(file);
    return bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46 ? bytes : undefined;
  } catch {
    return undefined;
  }
}
