import { readFileSync } from 'node:fs';
import { buildItems } from '@flat/assets';
import { buildShell, loadSceneText, SiteContext, sunAt } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { shadowCasterGeometry } from './derived-geometry';
import { fitSunForScene } from './sun-bounds';
import type { V3 } from './sun-fit';

const fixture = (name: string) => readFileSync(new URL(`../../scene/fixtures/${name}`, import.meta.url), 'utf8');
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

describe('sun shadow fit keeps the flat shell inside the shadow camera depth range', () => {
  const positions = shadowCasterGeometry(buildShell(scene, { items: buildItems })).getAttribute('position').array as Float32Array;
  const altitudes = [2, 6, 12, 18, 28.7, 45, 64, 80, 89];
  for (const withContext of [true, false]) {
    it(`every shell caster vertex lies within [near, far] for a sweep of sun directions (context: ${withContext})`, () => {
      let checked = 0;
      for (const alt of altitudes) {
        for (let az = 0; az < 360; az += 15) {
          const a = (alt * Math.PI) / 180;
          const z = (az * Math.PI) / 180;
          const dir: V3 = [Math.cos(a) * Math.sin(z), Math.sin(a), -Math.cos(a) * Math.cos(z)];
          const fit = fitSunForScene(scene, withContext ? context : null, dir)!;
          expect(fit).not.toBeNull();
          const toTarget = [fit.target[0] - fit.position[0], fit.target[1] - fit.position[1], fit.target[2] - fit.position[2]];
          const len = Math.hypot(...toTarget);
          const look = toTarget.map((c) => c / len);
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = 0; i < positions.length; i += 3) {
            const depth = (positions[i]! - fit.position[0]) * look[0]! + (positions[i + 1]! - fit.position[1]) * look[1]! + (positions[i + 2]! - fit.position[2]) * look[2]!;
            lo = Math.min(lo, depth);
            hi = Math.max(hi, depth);
            checked++;
          }
          expect(lo, `alt ${alt} az ${az}`).toBeGreaterThanOrEqual(fit.near);
          expect(hi, `alt ${alt} az ${az}`).toBeLessThanOrEqual(fit.far);
        }
      }
      expect(checked).toBeGreaterThan(1000);
    });
  }
});
