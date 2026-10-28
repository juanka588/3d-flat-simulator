# @flat/site

The blueprint-loading package: where a flat is (location, surroundings) and, from M6, what the official and developer
documents say about it. Two entries: `@flat/site` (pure: geodesy, polygons, BD TOPO to `SiteContext`, the fit,
contracts) and `@flat/site/node` (network and files: geocoder, WFS client, `getJson`, the CLI). Layout:

| Folder | Contents |
|---|---|
| `src/geo/` | ENU projection and bearings (`enu.ts`), polygon helpers (`polygon.ts`), `originDriftMeters` / `CONTEXT_MAX_DRIFT_M` (`drift.ts`) |
| `src/context/` | BD TOPO features to context rings and host bands (`bdtopo.ts`), `validateContext` over scene's zod `SiteContext` (`validate.ts`) |
| `src/fit/` | The rigid fit of a flat to the host footprint (`fit.ts`) |
| `src/cadastre/`, `src/plan/` | Contracts only (types, no code), see below |
| `src/node/` | `geocode.ts`, `wfs.ts`, `http.ts`, `cli.ts` (the context generator) |
| `legacy/` | The original untyped `.mjs` tool, kept until step 11 of `docs/architecture/modules.md` as the reference the TypeScript port was checked against. `tools/site-context/fetch.mjs` is a one-line shim to it |

## The cadastre gives parcels and footprints, not interiors

French cadastral databases (IGN API Carto *cadastre*, the Géoplateforme layer `CADASTRALPARCELS.PARCELLAIRE_EXPRESS`)
hold land parcels and building footprints. They do not hold floor plans. An "official blueprint" from the cadastre is
therefore the outer envelope of the building: good for checking and fitting a flat's traced envelope (the same job
BD TOPO does today), useless for walls, rooms and doors. The interior always comes from the developer's plan.
`src/cadastre/types.ts` is the contract (`CadastreParcel`, `CadastreBuilding`, `CadastreSource`): geometry only, no owner
fields, no personal data. There is no client yet; which source to use is a spike.

## The plan: from a developer's drawing to a draft Scene (contract only)

`src/plan/types.ts` defines `PlanSource` (a PDF or raster page plus its scale), `PlanTrace` (walls, openings and rooms in
plan metres, each with a confidence value) and the `TraceToCommands` signature (`PlanTrace` to scene command envelopes).
Reading the drawing (the vision-LLM step of M6) belongs in `apps/mcp`; this package will hold the deterministic half: scale,
snapping and validation against the Scene schema. A cadastre footprint, when available, is a hard constraint on the
traced envelope: the traced outer walls must fit inside it, which is the same fit `src/fit/fit.ts` performs today.

## The context generator (`site:context`)

Generates the neighbouring-buildings context of a flat (`*.context.json`, the `SiteContext` schema in
`packages/scene/src/context/schema.ts`) from open data, so the sun simulation includes their shadows.
Node >= 22, needs network access only when you regenerate; the committed JSON lets tests run offline.

## Usage

```sh
pnpm site:context \
  --flat packages/scene/fixtures/charme-3205.flat.json \
  --address "21 Rue de la Fontaine 92220 Bagneux" \
  --host-id BATIMENT0000002205927841
```

`node tools/site-context/fetch.mjs` (same flags) still works through the legacy shim.

Steps: geocode the address, fetch the IGN BD TOPO buildings within `--radius` (default 150 m) of the
host building, pick the host, derive the plan-to-map transform, write
`<flat>.context.json` next to the flat, and print the host, the tall neighbours with their compass
direction, and the suggested `site` values (`latitude`, `longitude`, `northAngle`) to paste into the flat.
The tool never edits the flat file, except with `--fit` / `--refit` (they rewrite its `site` block).

| Flag | Meaning |
|---|---|
| `--address`, or `--lat` + `--lon` | Search centre (default: the flat's `site.address`; a street geocodes to a point on the road, so a house number helps) |
| `--host-id` / `--host-point lat,lon` | The building that holds the flat (BD TOPO `cleabs`, or a point inside it). Without either, the building at/nearest the search centre is used, with a warning |
| `--north-angle <deg>` | Override `site.northAngle` (default: derived from the host footprint) |
| `--origin-lat`, `--origin-lon` | Override the WGS84 position of the flat's plan origin (the alcove's north-west inner corner) |
| `--anchor nw\|ne\|sw\|se` | Corner of the host's oriented bounding box that the flat's outer envelope touches (default `nw`) |
| `--wall-inset` | Distance from the plan origin to the outer face of the exterior walls (default: thickest wall, 0.2 m) |
| `--cut-margin`, `--slab` | Clearance around the flat in the host cut-away (0.05 m) and slab above the walls (0.3 m) |
| `--default-height`, `--storey` | Height when BD TOPO has no `hauteur` (9 m default; `nombre_d_etages` x 3 m is used first) |
| `--from-geojson`, `--save-geojson` | Replay / store the raw WFS response |
| `--fit`, `--refit <context.json>` | Rigidly fit the flat to the host footprint (and rewrite the flat's `site` block); `--refit` does it on an existing context, offline |
| `--out` | Output path |

To fine-tune by hand, re-run with `--north-angle`, `--origin-lat`, `--origin-lon` and copy the printed
values into the flat's `site` block (keep both files in sync: the context's `northAngle`/`origin` must
match the flat's `site`; a test checks it).

## Transform and projection

* Map frame: local ENU (east, north) in metres around the origin, equirectangular:
  `E = (lon - lon0) cos(lat0) R pi/180`, `N = (lat - lat0) R pi/180`, `R = 6371008.8 m`. At a few hundred
  metres the error is far below the accuracy of BD TOPO (planimetric precision about 1-3 m).
* Plan frame: x right, y down, as in the Scene. With the plan x axis at compass bearing `bx`:
  x axis = (sin bx, cos bx), y axis = (cos bx, -sin bx) in (E, N), and `northAngle = 90 - bx`
  (clockwise angle from plan up to true north, same as `site.northAngle`).
* Rotation: the host footprint's dominant edge direction (length-weighted, edges more than 8 degrees
  off ignored), taken modulo 90 degrees and chosen closest to "plan x = east". Translation: the flat's
  outer envelope (rooms without the balcony, plus `--wall-inset`) is pinned to the chosen corner of the
  host's oriented bounding box; the origin's lat/lon is computed from that.
* Ground: `base = -site.floorElevation` for every building (flat terrain assumed; BD TOPO ground
  altitudes are not used).
* Host: the building holding the flat is not a single solid box. It is written as bands with
  `host: true`: below the flat (up to 5 cm under its floor), the flat's storey minus the flat's wall
  bounds (plus margin), and above the flat's walls plus a slab. The roof band has an underside (the
  mesh builder closes any building whose base is above the lowest ground). The `:below` band is only
  written when there is something below the flat's storey (a ground-floor flat, `floorElevation` 0, has
  none). Inner rings (courtyards) of BD TOPO footprints are kept as `holes` on neighbours and on the host
  bands they lie inside; a host courtyard that touches the flat's cut-away or straddles two storey pieces
  is dropped from the storey band (conservatively solid).
* Robustness: features with null geometry are skipped with a warning; a host missing after re-centring is
  an error; 4xx responses (except 408/429) are not retried; the generated object is checked against a copy
  of the `SiteContext` rules (`validateContext`, which wraps scene's zod schema) and nothing is written, with exit
  code 1, if it is invalid. The helpers are tested in `src/context/context-tool.test.ts`.
* Golden test: `src/node/golden.test.ts` replays a recorded BD TOPO response (`test/fixtures/bdtopo-bagneux-batiment.geojson`)
  through the whole CLI and requires `packages/scene/fixtures/charme-3205.context.json` byte for byte (see the test for the
  two documented caveats). Regenerating the committed context with new data means re-recording this fixture too.

## Data

Buildings: IGN BD TOPO V3 (`BDTOPO_V3:batiment`), (c) IGN, published under the Licence Ouverte
Etalab 2.0 (https://www.etalab.gouv.fr/licence-ouverte-open-licence/). The recorded response under
`test/fixtures/` is a reduced extract of it (geometry plus `cleabs`, `nature`, `usage_1`, `hauteur`, `nombre_d_etages`) and carries
the same licence and attribution (an `attribution` member in the file). Geocoding: Geoplateforme
(`data.geopf.fr/geocodage`, based on the Base Adresse Nationale). Keep the `source` string in the
generated file when redistributing.
