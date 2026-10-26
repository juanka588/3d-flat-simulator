import { readFileSync } from 'node:fs';
import { loadSceneText, SiteContext, sunAt } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { fitSunForScene } from './sun-bounds';

const fixture = (name: string) => readFileSync(new URL(`../../../../packages/scene/fixtures/${name}`, import.meta.url), 'utf8');
const loaded = loadSceneText(fixture('charme-3205.flat.json'));
if (!loaded.ok) throw new Error('fixture does not load');
const scene = loaded.scene;
const context = SiteContext.parse(JSON.parse(fixture('charme-3205.context.json')));

describe('sun shadow fit with the Charme context', () => {
  const cases: [string, string][] = [
    ['2026-12-21', '09:00'],
    ['2026-12-21', '12:00'],
    ['2026-12-21', '15:30'],
    ['2026-06-21', '08:00'],
    ['2026-06-21', '12:00'],
    ['2026-06-21', '18:00'],
    ['2026-03-21', '17:30'],
  ];
  for (const [date, time] of cases) {
    it(`keeps the depth range within tens of metres at ${date} ${time}`, () => {
      const sun = sunAt(scene.site, date, time);
      expect(sun.isUp).toBe(true);
      const fit = fitSunForScene(scene, context, [sun.direction[0], sun.direction[1], sun.direction[2]])!;
      const range = fit.far - fit.near;
      expect(range).toBeGreaterThan(5);
      expect(range).toBeLessThan(80);
      // Sideways extent is just the flat.
      expect(fit.right - fit.left).toBeLessThan(30);
      expect(fit.top - fit.bottom).toBeLessThan(30);
    });
  }

  it('is far deeper if every building is a caster (what the filter avoids)', () => {
    const sun = sunAt(scene.site, '2026-12-21', '09:00');
    const dir: [number, number, number] = [sun.direction[0], sun.direction[1], sun.direction[2]];
    const all = fitSunForScene(scene, { ...context, buildings: [] }, dir)!;
    expect(all.far - all.near).toBeLessThan(40);
  });
});
