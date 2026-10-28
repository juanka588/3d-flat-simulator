# @flat/capture

Placeholder package: contracts (zod schemas and types) for bringing real-world data (photos, videos, scans) into a Scene. There is no importer yet (M7 and backlog route E will add them). See `docs/architecture/modules.md` section 1.5.

## Contents

- `CaptureAsset`: `photo | video | scan`, mime type, EXIF time and GPS, camera intrinsics.
- `CaptureAnchor`: the pose of a capture in Scene coordinates.
- `Observation`: a distance, a colour sample (wall side or floor), a detected opening, a detected item with dims.
- `CaptureImporter`: `observe(asset): Promise<Observation[]>`.
- `observationsToCommands(scene, observations)`: turns observations into `CommandEnvelope`s authored as `planner`.

**Capture never writes a Scene.** It only proposes commands, so undo, history, structural guards and the MCP preview all apply. No new author kind is introduced.

## Privacy rule

Captures are personal data: a photo of a home with GPS EXIF reveals where the user lives. They are treated like retailer data:

- local-only: nothing captured may be committed, bundled or served from GitHub Pages;
- stored only under `apps/server/data/`, or a gitignored `captures/` directory;
- guarded by `scripts/ci/retailer-hosts.json`: `captures` is in `denyDirs`, `**/*.heic` and `**/*.mov` are in `denyFiles`, and `check-no-retailer` fails on any tracked match.

Test fixtures must be synthetic (generated, no real location, no real home).

## Dependencies

`@flat/scene` only (`@flat/site` is allowed by the boundary rules, for EXIF GPS to ENU, but is not used yet). No Node built-ins, no renderer.
