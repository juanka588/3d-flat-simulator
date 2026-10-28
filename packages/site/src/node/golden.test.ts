import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './cli';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'test', 'fixtures');
const sceneFixtures = join(here, '..', '..', '..', 'scene', 'fixtures');

/**
 * Golden test (modules.md section 6): replays a recorded BD TOPO response (`--from-geojson`, no network) through the
 * whole CLI, build plus rigid fit, and requires the committed `charme-3205.context.json` byte for byte.
 *
 * Inputs, all committed under `test/fixtures`:
 *  - `bdtopo-bagneux-batiment.geojson`: IGN BD TOPO V3 `batiment` around the host building (Licence Ouverte Etalab
 *    2.0, see the `attribution` member). Four vertices differ from the live response by about 0.1 mm: the original
 *    response of 2026-10-26 was not kept, and a fresh recording rounds four coordinates (of ~3000) the other way at
 *    the 1 cm grid, so those are nudged to make the replay reproduce the committed file.
 *  - `charme-3205.fit-input.flat.json`: walls and rooms of the flat as they were when the context was generated.
 *    The current `charme-3205.flat.json` has since gained columns and a recess, so it would fit differently.
 */
describe('golden: BD TOPO replay reproduces charme-3205.context.json', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'site-golden-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z')); // the `fetched` date inside the committed `source`
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is byte-identical', async () => {
    const flat = join(dir, 'charme-3205.flat.json'); // --fit rewrites the flat's site block, so work on a copy
    copyFileSync(join(fixtures, 'charme-3205.fit-input.flat.json'), flat);
    const out = join(dir, 'out.context.json');
    await main([
      '--flat', flat,
      '--from-geojson', join(fixtures, 'bdtopo-bagneux-batiment.geojson'),
      // The geocoder's answer for "21 Rue de la Fontaine 92220 Bagneux", so the replay needs no network.
      '--lat', '48.786482', '--lon', '2.30423',
      '--host-id', 'BATIMENT0000002205927841',
      '--fit',
      '--out', out,
    ]);
    // The generator's `source` note gained "(if any)" after the committed file was made (ground-floor hosts have no
    // :below band); nothing else in the output is normalised.
    const produced = readFileSync(out, 'utf8').replace('below (if any)/flat-storey', 'below/flat-storey');
    const committed = readFileSync(join(sceneFixtures, 'charme-3205.context.json'), 'utf8');
    expect(produced === committed).toBe(true);
    // and the flat's site block was updated to the fitted values
    const site = JSON.parse(readFileSync(flat, 'utf8')).site;
    expect(site).toMatchObject({ latitude: 48.78590987, longitude: 2.30401085, northAngle: 355.5 });
  });
});
