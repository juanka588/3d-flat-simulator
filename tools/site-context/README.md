# site-context

Generates the neighbouring-buildings context of a flat (`*.context.json`, the `SiteContext` schema in
`packages/scene/src/context/schema.ts`) from open data, so the sun simulation includes their shadows.
Node >= 22, no dependencies, needs network access only when you regenerate; the committed JSON lets
tests run offline.

## Usage

```sh
node tools/site-context/fetch.mjs \
  --flat packages/scene/fixtures/charme-3205.flat.json \
  --address "21 Rue de la Fontaine 92220 Bagneux" \
  --host-id BATIMENT0000002205927841
```

Steps: geocode the address, fetch the IGN BD TOPO buildings within `--radius` (default 150 m) of the
host building, pick the host, derive the plan-to-map transform, write
`<flat>.context.json` next to the flat, and print the host, the tall neighbours with their compass
direction, and the suggested `site` values (`latitude`, `longitude`, `northAngle`) to paste into the flat.
The tool never edits the flat file.

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
  mesh builder closes any building whose base is above the lowest ground).
  Holes (courtyards) in BD TOPO footprints are ignored.

## Data

Buildings: IGN BD TOPO V3 (`BDTOPO_V3:batiment`), (c) IGN, published under the Licence Ouverte
Etalab 2.0 (https://www.etalab.gouv.fr/licence-ouverte-open-licence/). Geocoding: Geoplateforme
(`data.geopf.fr/geocodage`, based on the Base Adresse Nationale). Keep the `source` string in the
generated file when redistributing.
