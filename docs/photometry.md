# Photometry and sun model

Implemented in `packages/scene/src/lighting/*` (pure TypeScript, no three.js). This document
records the conventions and the tuning decisions behind them.

## Decision: exact geometry, tuned brightness

Sun **geometry** (position, direction, rise/set, shadow and sun-patch projection) is exact: it
comes from `suncalc` (v2, apparent altitude including refraction) and the site's latitude,
longitude, time zone and `northAngle`. Sun and sky **brightness** are "physically based but
tuned for screen": real units (lux, candela, nits) feed the renderer's physical lights, and a
smooth exposure curve maps them to a readable image. The exposure curve deliberately compresses
the real dynamic range (about 10^6 : 1 between a starlit and a sunlit scene) instead of
reproducing it.

## Conventions

- **suncalc v2 azimuth** is a compass bearing: clockwise from true north (0 = N, 90 = E,
  180 = S, 270 = W). (v1 measured from south, positive towards west; do not mix them up.)
- **World axes**: X = plan x, Z = plan y (plan y points down the page), Y = up.
- **`site.northAngle`**: clockwise angle, as drawn on the plan, from plan "up" (-y) to true
  north. True north therefore appears at plan bearing `northAngle`, and a compass bearing `b`
  appears at plan bearing `b + northAngle` (clockwise from plan "up").
- A plan bearing `p` is the plan vector `(x, y) = (sin p, -cos p)`. The world direction towards
  a sun of compass azimuth `A` and altitude `h` is

  ```
  X =  sin(A + northAngle) cos h
  Y =  sin h
  Z = -cos(A + northAngle) cos h
  ```

  With `northAngle = 0`: south is +Z (plan down), east +X, north -Z, west -X. With
  `northAngle = 90` north is on the right of the plan (+X) and east at the bottom (+Z).
  `sunDirection(azimuthDeg, altitudeDeg, northAngle)` implements this.
- Local date/time are wall-clock values in `site.timezone` (IANA). `localToInstant` resolves a
  DST gap forward (2026-03-29 02:30 Europe/Paris -> 03:30 CEST) and a DST overlap to the earlier
  instant (2026-10-25 02:30 -> CEST). Malformed dates/times and unknown zones throw.
- `isUp` means the sun's centre is above -0.833 degrees (sunrise/sunset altitude).

## Direct sun

`illuminanceLux` is the illuminance on a surface facing the sun under a clear sky:

```
E = 128000 * 0.8^AM(h) * fade(h)
AM(h) = 1 / (sin h + 0.50572 (h + 6.07995)^-1.6364)      (Kasten-Young 1989, h in degrees)
fade  = smoothstep from -0.833 to +2 degrees
```

About 102 klx at the zenith (AM = 1), about 80 klx at 64.6 degrees (Paris, 21 Jun), a few
klx at 5 degrees, and exactly 0 at and below the horizon, with no step at sunrise.

## Sky and ambient

`skyState(altitude)` is continuous in altitude. Diffuse horizontal illuminance is interpolated
(smoothstep, in log10 lux) through: -18 deg 0.001 lx, -12 deg 0.1, -6 deg 3 (civil twilight),
-0.833 deg 400, 6 deg 5 klx, 15 deg 10 klx, 30 deg 14 klx, 60 deg 16.5 klx, 90 deg 17.8 klx, and
the 0.001 lx floor is subtracted so `ambientLux` is exactly 0 at -18 deg and below. It is
monotonic in altitude. Zenith and horizon colours (linear RGB) are keyframed in altitude:
deep blue at the zenith by day, a warm orange horizon around 0 degrees, near-black below
-18 degrees.

## Lamp conversions (three.js physical units)

| Light | Formula | three.js |
| --- | --- | --- |
| point | `cd = lm / 4pi` | `PointLight.intensity` (decay 2, distance 0) |
| spot (full cone theta) | `cd = lm / (2pi (1 - cos(theta/2)))` | `SpotLight.intensity`; `angle = theta/2` in radians |
| area panel | `nits = lm / (pi w d)` (`areaNits`, for readouts) | the viewer renders it as a shadow-casting `PointLight` just below the panel at `cd = lm / (2pi)`, see "Shadows, lamps and ambient" |

Examples: 1600 lm point = 127.3 cd; 600 lm at 100 degrees = 267.3 cd; 2500 lm on a
1.2 x 0.3 m panel = 2210 nits. Zero lumens give zero. Spot angles are clamped to
[0.01, 180] degrees so the intensity stays finite (a 179 degree spot is about lm / 2pi).

`kelvinToLinearRgb(K)` uses Tanner Helland's sRGB approximation (1000-40000 K), converts it to
linear light and scales the result so the relative luminance (Rec. 709: 0.2126 R + 0.7152 G +
0.0722 B) is 1. Lamps therefore change hue, not brightness; warm colours have components above 1
(2700 K is about R 2.0, G 0.77, B 0.19). 6500 K is neutral to within 5%, and the blue/red ratio
increases monotonically from 1000 to 12000 K.

## Auto exposure

`autoExposure(sunLux, ambientLux, lampLux)` returns the multiplier for
`renderer.toneMappingExposure` before the user's EV compensation:

```
E        = sunLux + ambientLux + lampLux          (total illuminance, lux)
exposure = 0.3718 * (E + 0.05)^-0.7
```

This is a power law with exponent 0.7: the eye/camera adapts to 70% of the log-illuminance
change (partial adaptation), which is why a lamp-lit room stays readable and noon does not
look pitch black. Properties: smooth, strictly decreasing in `E`, finite in total darkness
(the 0.05 lx soft floor gives about 3.0 at E = 0, no clamping needed).

| Situation | E (lux) | exposure |
| --- | --- | --- |
| clear noon, Paris, 21 Jun | about 97000 | about 1.2e-4 (roughly "1/10000") |
| overcast-ish day | 10000 | about 6e-4 |
| lamp-lit room | 150 | about 1.0e-2 |
| dim room | 20 | about 4.5e-2 |
| night, no lamps | 0 | about 3 |

For a surface of albedo 0.5, `radiance = 0.5 E_surface / pi * exposure`: a wall lit by a
150 lx lamp gives about 0.24 (readable mid-tone); at noon a sky-lit (shaded) surface of about
17 klx gives about 0.3 and a sun-lit one about 1.5-1.9 (bright, handled by the tone mapper).
The curve is tuned, not calibrated; the viewer adds `exposureEV` (stops, `exposure * 2^EV`)
on top. The viewer evaluates it on the screen-tuned (compressed) daylight below, so the noon
numbers in this table are for the physical inputs; the rendered noon exposure is about 2.8e-4.

## Screen tuning of daylight (web layer)

`autoExposure` and the physical sun above are unchanged in `@flat/scene` and still feed the
readouts (`sunLux`, `ambientLux`). But feeding them straight to three.js gave a bad daytime
image: exposure keyed on ~87 klx of sun left the shade (hemisphere only 0.3 x 17 klx, tinted
deep blue and with a colour of luminance ~0.25) crushed to navy while every sun patch clipped.
Per the "exact geometry, tuned brightness" decision, `apps/web/src/viewer/lighting.ts`
compresses the daylight dynamic range for the screen (geometry, shadows and patches stay exact):

| Constant | Value | Meaning |
| --- | --- | --- |
| `AMBIENT_FRACTION` | 0.5 | `HemisphereLight.intensity = 0.5 x ambientLux` (about 8 klx at noon) |
| `AMBIENT_DESATURATION` | 0.92 | sky colour pulled this far to white, then normalised to luminance 1 so intensity is true lux and shade is neutral |
| `AMBIENT_GROUND_LUMINANCE` | 0.55 | ground (bounce) colour luminance relative to the sky |
| `SUN_TO_AMBIENT_RATIO` | 2 | rendered sun saturates at about 2 x the rendered hemisphere |

- **Rendered sun**: `sunIntensity = c (1 - exp(-sunLux / c))`, `c = 2 x ambientIntensity`. It is
  the identity for a weak sun (low sun, dusk), monotonic, and zero with the sun. At noon, 21 Jun:
  80 klx becomes about 20 klx, i.e. a horizontal sun patch is about 3x as bright as shade
  instead of 6x.
- **Exposure key**: `autoExposure(sunIntensity, ambientIntensity, lampLux)`, i.e. the formula
  above applied to the *rendered* illuminance, not the physical one: about 2.8e-4 at noon
  (was 1.2e-4), 1.1e-3 at 16:20 in December. With no sun (night, evening, lamps-only) the sun
  and hemisphere terms are zero, so those scenes are bit-for-bit unchanged.
- **Sky dome**: our own gradient shader (zenith to horizon colours from `skyState`, a warm halo
  and disc around the sun), not the drei/three `Sky`, whose HDR output is unscaled relative to
  the flat's exposure and rendered flat grey. It ignores tone mapping and depth and follows the
  camera. Below the horizon it continues the lit context ground (`groundDisplay`: ground albedo
  0.16 x rendered irradiance x exposure), because the orbit and top cameras only see the sky
  dome below the horizon; blue sky is visible in walk mode and through windows.
- **Lamps** are untouched and physical. They default to off in the app's initial view (the
  `day` preset is applied when the first scene loads); toggling and presets still work.

## Shadows, lamps and ambient (web layer)

How `apps/web/src/viewer` turns the lights above into shadows. All numbers were measured on
Charme 3205 with the software renderer used by the e2e suite.

**Sun shadow frustum** (`sun-bounds.ts`, `sun-fit.ts`). The orthographic frustum covers the
flat plus its balcony sideways. Its depth range covers only the context buildings that can
shade them: those whose projection perpendicular to the sun overlaps the flat's extent, that
reach the sun side of the flat, and whose roof is above the lowest ray from the flat towards the
sun (their depth is capped where that ray clears the roof). Fitting every one of the 160 buildings
gave a 235-436 m depth range at low sun; now it is 20-60 m (about 170 m only at a grazing 1 degree
sunrise), asserted in `sun-bounds.test.ts`.

**Bias in world units.** The sun's shadow depth is linear over `far - near`, and three.js's `bias` is in
those normalised units, so a fixed `-0.0005` was 0.2 m of light leaking under walls for a 400 m
range. The sun now uses `bias = -K / (far - near)` with `K = 0.015 m` and
`normalBias = 2 texels` (`sun-shadow.ts`). e2e probes put floor points 5 cm behind a wall at low sun
and require them to stay dark (it fails with `K = 0.25 m`).

**Lamp bias** (`lamp-shadow.ts`). Point and spot shadows are perspective: three.js compares
`z = f (d - n) / (d (f - n))` (depth-buffer units, `d` = distance along the shadow camera axis), so
the same `bias` is a different number of metres at each distance (`dz/dd = n f / (d^2 (f - n))`:
the metres grow with `d^2`). A linear "K / range" conversion, as used for the sun, was wrong by
orders of magnitude here. The bias is now `-K n f / (d0^2 (f - n))` with `K = 0.02 m` at a
reference distance `d0 = 3 m` (near 0.1, far 16), and `normalBias = 0.05 m` (this one IS in
metres) covers walls seen at a grazing angle from the lamp. Shadow maps are 512 per cube face for
points, 1024 for the kitchen panel and the spots.

**Area panels.** `RectAreaLight` cannot cast shadows, so it lit rooms through walls. The first
replacement, a 87 degree half-angle `SpotLight`, was wrong: its 174 degree perspective shadow frustum
loses nearly all resolution and depth precision towards its edge, giving heavy stripes (acne) on side
walls and light leaking through walls onto the balcony and outside the flat. An area lamp is now a
`PointLight` (a cube shadow map: six 90 degree faces) 6 cm below the panel centre, so the cube
sees the room and not the panel body, with `cd = lm / (2pi)`. A Lambertian panel sends its whole
flux `lm` into the lower hemisphere; a point light of `cd` radiates `4pi cd` into the whole
sphere, so `cd = lm / (2pi)` puts the same flux `lm` below the ceiling plane. (The upper half
lights the ceiling around the panel, a soft halo, and nothing above it, see below.) The peak
intensity straight down is therefore `lm / (2pi)`, half of the Lambertian peak `lm / pi`: a panel
looks a bit dimmer directly below and wider-spread than a true cosine emitter. The emissive panel
mesh stays for the look; there is no `RectAreaLight`, so no specular from the panel.

**Slabs shut lamp light in.** Shadow passes draw the back faces of casters, so a floor (facing up)
was invisible to a lamp above it, and a ceiling (facing down) to a lamp below it: lamps lit the
ground and the roof band through the slabs (a faint ring around the flat, visible at night
because the exposure is high). `shadowCasterGeometry` now also contains, for every room, a copy of
the floor reversed (facing down) 2 cm below it and a copy of the ceiling reversed 2 cm above it.
The fixtures receive shadows too, so an off lamp body is not lit through walls by another lamp.
Light still enters and leaves through window and door openings: glass does not cast.

**Static shadow maps.** The scene is static, so no shadow map is re-rendered per frame. Every
point and spot lamp (and the area proxies) casts shadows permanently, on or off (an off lamp has
intensity 0), with modest maps (point 512 per face, kitchen panel and spot 1024, sun 2048), so the number of shadow-casting
lights is constant and toggling lamps or walking never recompiles shaders (the fixture material is
also one type in both states). All `shadow.autoUpdate` are `false`; `shadow.needsUpdate` is set only
when the scene or the visible context changes, a lamp's intensity changes (that lamp only), or the
sun direction, intensity or activity changes (the frustum is refitted at the same time).

Draw calls (`renderer.info.render.calls`, Charme with context):

| Frame | Calls |
| --- | --- |
| steady, day / evening / night / noon with every lamp on | 21-23 |
| steady, walk mode | 16 |
| right after moving the sun (one sun shadow pass) | 26 (+3) |
| right after toggling one lamp | 27 (+6) |
| right after the Night preset or a scene load (every lamp's maps) | 60 (+39) |

The budget (70) applies to steady frames; change frames may use up to twice that
(`e2e/lighting.e2e.ts`, which also keeps the four fixed scenes within it). While the day animation
plays, the sun changes every frame, so it costs the sun pass (+3) per frame.

**Per-room sky ambient.** A hemisphere light cannot be shadowed by walls, so a windowless WC would
get the same sky light as the living room. The room daylight factor (`roomDaylightFactors`) is
applied to the hemisphere light only: three.js multiplies just the indirect diffuse light by a
material's `aoMap`, so the shell materials get a one-row texture with one texel per room (plus a
full-sky texel) as `aoMap` with `aoMapIntensity = 1`, read through a second UV set
(`uv1`, `texture.channel = 1`). Floors and ceilings use their own room, the left/right face of a
wall the room on that face (`wallSideRooms`, per stretch of wall), a fitting's vertical faces the
room they look at; tops, ends, jambs, glass and faces looking outside use 1. Lamps and the sun are
untouched. Vertices shared between triangles of different rooms are duplicated, so picking is
unchanged (`room-ambient.ts`). At noon the WC and SDB floors render clearly darker than the
living room floor.

**Site context after Site edits.** `siteContext.alignContext` follows later edits of `scene.site`
without re-running `tools/site-context`: the context is rotated about the flat origin by
`site.northAngle - context.northAngle` (clockwise on the plan, `(x, y) -> (x cos t - y sin t,
x sin t + y cos t)`), its bases shift by the floor-elevation difference (ground at
`-site.floorElevation`), and when the site is more than 50 m from the context's origin the context is
hidden and the viewer asks for `tools/site-context` to be re-run. The IGN BD TOPO attribution is
shown whenever the context is visible.

## Sun patches and sunlight hours

`sunPatches(scene, direction)` projects every glazed opening (windows by default, doors with
`glazed: true`; passages never) along `-direction` onto the floor plane y = 0:

- The opening rectangle lies in the wall's centreline plane, from `sill` to `sill + height`
  (head clamped to wall height), `offset +/- width/2` along the wall (clamped to the wall).
- Floor point of wall point `P` at height `y`: `P_plan - (dirX, dirZ) * y / dirY`. Patch depth
  from the wall is `head / tan(altitude)`: 1.05 m for a 2.2 m head at 64.6 degrees, 6.9 m at
  17.7 degrees.
- The light enters only if the sun-facing side of the wall is exterior: the point 0.15 m
  beyond the wall face on the sun side must not lie in an indoor room (rooms of type
  `balcony` count as outdoors), and the opposite side must lie in a room. That room is the
  only one clipped to, so light does not pass through partitions into neighbouring rooms.
- The opening's receiving room is looked up with the same indoor test, so a window or door
  into a `balcony` room is never reported (balconies are never sunlit).
- Clipping is Sutherland-Hodgman against the room polygon when it is convex, and against each
  `earcut` triangle when it is concave (one patch fragment per triangle, same
  `openingId`/`roomId`, non-overlapping; areas add up).

`sunlightHours(scene, date, stepMinutes = 10, context?)` samples the local civil day (23/24/25 h
on DST days) at the middle of each step and adds `step` to every room whose total patch area
exceeds 0.05 m2.

### Obstruction by neighbouring buildings (optional `context`)

Both functions take an optional `SiteContext` (the `*.context.json` produced by
`tools/site-context`). Without it nothing is obstructed (the previous behaviour). With it, each
glazed opening is cut into a 3 x 3 grid of cells (along the wall and up the glass). For each cell
a ray from its centre, on the wall's centreline plane, towards the sun is tested against the
context buildings, each a vertical prism (footprint minus `holes`, from `base` to
`base + height`); the ray is blocked when the part of it inside a prism's height range starts or
ends in solid material or crosses a footprint or hole edge. A cell whose ray is blocked
contributes no patch; the free cells project to disjoint parallelograms that are clipped to the
room as usual. So partial obstruction clips the patch to the unobstructed ninths of the glass
(lit area quantised to 1/9), all free gives exactly the unobstructed patch, all blocked gives
none.

Which buildings count: every neighbour (`host: false`), and the host bands that start at or above
the flat's wall height (the roof band above the flat, which overhangs balconies and windows
under it). The host's below band cannot lie above a ray, and the flat-storey bands surround the
flat's own cut-away, so they never block its windows.

Reference results for the Charme 3205 flat (Bagneux, `northAngle` 358.5; hours of direct sun,
10 minute steps). "Free" ignores neighbouring buildings; "context" uses
`packages/scene/fixtures/charme-3205.context.json` (IGN BD TOPO). Neither includes the balcony
slab or railing.

| Room | 21 Mar free | 21 Mar context | 21 Jun free | 21 Jun context | 21 Dec free | 21 Dec context |
| --- | --- | --- | --- | --- | --- | --- |
| Sejour / cuisine (west French doors) | 5.7 h | 4.8 h | 7.5 h | 7.5 h | 3.7 h | 1.3 h |
| Alcove (north window) | 0 | 0 | 3.3 h | 3.3 h | 0 | 0 |
| Chambre 2 (north window) | 0 | 0 | 1.8 h | 1.8 h | 0 | 0 |
| Chambre 1 (north window) | 0 | 0 | 2.2 h | 2.2 h | 0 | 0 |
| Entree, WC, SDB, balcon | 0 | 0 | 0 | 0 | 0 | 0 |

The values are asserted in `sunpatch.test.ts`. The neighbours mostly cost the living room its
low winter and equinox afternoon sun; the summer sun is high enough to clear them.

## Room daylight factors

`roomDaylightFactors(scene)` returns, per room id, how much sky light reaches the room (0..1), for
the viewer to scale its sky ambient with so windowless rooms are not lit as if open to the sky:

```
own    = clamp(5 x glazedArea / floorArea)           glazed windows/doors whose other side is outdoors
factor = clamp(max(own, 0.08) + 0.15 x max(own of the rooms joined by a door or passage))
balcony = 1
```

Charme: sejour 1.0, alcove 1.0, chambre 2 0.69, chambre 1 0.55, entree 0.23, WC and SDB 0.08,
balcon 1. `wallSideRooms(scene)` gives each wall's left/right room (see `wallLeftNormal`), taken 5 cm
beyond the face at mid-span, plus per-stretch `segments` (25 cm samples merged by room pair)
so a long facade over several rooms can be shaded per room.

## Limitations

- Neighbouring buildings only obstruct when a `context` is passed; balcony slab/railing, interior
  walls and door leaves never do; window reveals and frames are ignored (the glass sits on the wall centreline).
- Floor only: sun on walls, furniture or ceilings is not computed. Balconies are outdoor
  and never reported as sunlit.
- Clear-sky model only: no clouds, no atmospheric variation (turbidity, altitude).
- Exposure is a screen-oriented curve, not a calibrated camera model.
