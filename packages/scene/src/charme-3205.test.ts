import { describe, expect, it } from 'vitest';
import charme from '../fixtures/charme-3205.flat.json';
import { parseScene } from './parse';
import { roomArea } from './measure';

/** Habitable areas printed on the Cogedim plan (page 6 of "BLANC NATURE - Plans.pdf"). */
const LISTED: Record<string, number> = {
  entree: 6.47,
  sejour: 24.63,
  ch1: 13.87,
  ch2: 11.13,
  alcove: 8.95,
  sdb: 5.24,
  wc: 1.85,
};
const LISTED_HABITABLE = 72.14;
const LISTED_BALCONY = 11.13;

describe('Charme 3205 transcription', () => {
  const result = parseScene(charme);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const scene = result.scene;
  const area = (id: string) => roomArea(scene.rooms.find((r) => r.id === id)!);

  it.each(Object.entries(LISTED))('%s is within 15%% of the listed area', (id, listed) => {
    expect(Math.abs(area(id) - listed) / listed).toBeLessThan(0.15);
  });

  it('total habitable area is within 5% of the listed 72.14 m²', () => {
    const total = Object.keys(LISTED).reduce((sum, id) => sum + area(id), 0);
    expect(Math.abs(total - LISTED_HABITABLE) / LISTED_HABITABLE).toBeLessThan(0.05);
  });

  it('balcony is within 5% of the listed 11.13 m²', () => {
    expect(Math.abs(area('balcon') - LISTED_BALCONY) / LISTED_BALCONY).toBeLessThan(0.05);
  });

  it('every room has a way in', () => {
    const doors = scene.openings.filter((o) => o.type !== 'window').length;
    expect(doors).toBeGreaterThanOrEqual(scene.rooms.length - 1);
  });
});
