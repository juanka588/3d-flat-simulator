/**
 * Wall panelling (boiserie), cornice and chevron / herringbone parquet: the commands change the scene, the viewer draws
 * real mouldings in the shared wall mesh (no extra draw call for tone-on-tone frames) and a procedural parquet map, and
 * undo takes it all away again. Software GL; the scene is asserted through `window.__flat`, plus a screenshot.
 *
 * Screenshots: panelling-room.png (room overview of the séjour) and panelling-closeup.png (sage walls, white frames), under E2E_OUT or .tmp/e2e-panelling.
 */
import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { roomOverviewPose } from '../packages/scene/src/index';
import type { Scene } from '../packages/scene/src/index';
import { openApp, rendered, savePng } from './helpers';

const OUT = process.env.E2E_OUT ?? '.tmp/e2e-panelling';

const stats = (page: Page) => page.evaluate(() => window.__flat!.stats());
const apply = (page: Page, cmd: Record<string, unknown>) => page.evaluate((c) => window.__flat!.applyCommand(c), cmd);

test('panelling, cornice and a chevron floor are drawn, cheap, and undoable', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  await openApp(page);
  const scene = (await page.evaluate(() => window.__flat!.getScene())) as Scene;
  const pose = roomOverviewPose(scene, 'sejour', { aspect: 1280 / 800 });
  await page.evaluate((p) => window.__flat!.setCamera(p), pose);
  await rendered(page);
  const before = await stats(page);

  const results = [
    await apply(page, {
      type: 'material.define',
      material: { id: 'parquet-chevron', name: 'Chevron oak', kind: 'paint', color: '#a47a4d', roughness: 0.55, pattern: 'chevron', plankWidthMm: 90 },
    }),
    await apply(page, { type: 'room.setFloor', roomId: 'sejour', materialId: 'parquet-chevron' }),
    await apply(page, { type: 'room.setWallFinish', roomId: 'sejour', panelling: 'frames+dado', corniceMm: 100 }),
  ];
  for (const r of results) expect(r.ok, JSON.stringify(r)).toBe(true);
  await rendered(page);

  const sc = (await page.evaluate(() => window.__flat!.getScene())) as Scene;
  const room = sc.rooms.find((r) => r.id === 'sejour')!;
  expect(room.panelling).toMatchObject({ style: 'frames+dado' });
  expect(room.cornice).toStrictEqual({ heightMm: 100 });
  expect(sc.materials.find((m) => m.id === 'parquet-chevron')).toMatchObject({ pattern: 'chevron' });

  const after = await stats(page);
  // Real geometry: hundreds of triangles of bevelled frames, a dado rail and the cornice.
  expect(after.triangles - before.triangles).toBeGreaterThan(400);
  // Frames and rail share the wall paint (no extra draw call); only the parquet floor adds a material group and a map.
  expect(after.calls - before.calls).toBeLessThanOrEqual(3);
  expect(after.textures).toBeGreaterThan(before.textures);
  await savePng(page, `${OUT}/panelling-room.png`);


  // Sage walls with white frames, seen lower and closer: a coloured moulding adds one shared material for the whole room.
  const sage = await apply(page, { type: 'material.define', material: { id: 'paint-sage', name: 'Sage', kind: 'paint', color: '#a3ae93', roughness: 0.9 } });
  const coloured = await apply(page, { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'paint-sage', panelColour: '#f4f1ea' });
  expect(sage.ok && coloured.ok).toBe(true);
  await page.evaluate((p) => window.__flat!.setCamera(p), { ...pose, elevationDeg: 28, distance: pose.distance * 0.75 });
  await rendered(page);
  expect((await stats(page)).calls - after.calls).toBeLessThanOrEqual(4);
  await savePng(page, `${OUT}/panelling-closeup.png`);

  // One undo per command: paint + colour, sage, mouldings and cornice, floor, material.
  for (let i = 0; i < 5; i++) expect((await page.evaluate(() => window.__flat!.undo())).ok).toBe(true);
  await page.evaluate((p) => window.__flat!.setCamera(p), pose);
  await rendered(page);
  const undone = (await page.evaluate(() => window.__flat!.getScene())) as Scene;
  expect(undone.rooms.find((r) => r.id === 'sejour')!.panelling).toBeUndefined();
  expect(undone.materials.some((m) => m.id === 'parquet-chevron')).toBe(false);
  expect(Math.abs((await stats(page)).triangles - before.triangles)).toBeLessThan(20);

  expect(problems).toEqual([]);
});
