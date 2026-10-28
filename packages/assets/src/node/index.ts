// Node-only entry of @flat/assets (docs/architecture/modules.md section 1.2): the local 3D-FUTURE pack, read from disk.
// Imported by apps/server only (the Pages bundle never reaches it).
export { LOCAL_MESH_MAX_BYTES, localModelId, readLocalCatalog, readLocalModel } from './local-pack';
