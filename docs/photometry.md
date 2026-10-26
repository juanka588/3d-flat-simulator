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
| area panel | `nits = lm / (pi w d)` | `RectAreaLight.intensity` (Lambertian) |

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
- Clipping is Sutherland-Hodgman against the room polygon when it is convex, and against each
  `earcut` triangle when it is concave (one patch fragment per triangle, same
  `openingId`/`roomId`, non-overlapping; areas add up).

`sunlightHours(scene, date, stepMinutes = 10)` samples the local civil day (23/24/25 h on DST
days) at the middle of each step and adds `step` to every room whose total patch area
exceeds 0.05 m2.

Reference results for the Charme 3205 flat (Bagneux, `northAngle` 0, no obstruction by
neighbouring buildings or the balcony slab):

| Room | 21 Mar | 21 Jun | 21 Dec |
| --- | --- | --- | --- |
| Sejour / cuisine (west French doors) | 5.7 h | 7.5 h | 3.7 h |
| Alcove (north window) | 0 | 3.3 h | 0 |
| Chambre 2 (north window) | 0 | 1.7 h | 0 |
| Chambre 1 (north window) | 0 | 2.0 h | 0 |
| Entree, WC, SDB, balcon | 0 | 0 | 0 |

## Limitations

- No obstruction by neighbouring buildings, balcony slab/railing, interior walls or door
  leaves; window reveals and frames are ignored (the glass sits on the wall centreline).
- Floor only: sun on walls, furniture or ceilings is not computed. Balconies are outdoor
  and never reported as sunlit.
- Clear-sky model only: no clouds, no atmospheric variation (turbidity, altitude).
- Exposure is a screen-oriented curve, not a calibrated camera model.
