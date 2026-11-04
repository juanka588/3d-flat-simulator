import { describe, expect, it } from 'vitest';
import { buildReferencePrompt, plain, plainName } from '../imagegen/prompts';
import { loadStyles } from '../styles';
import { charmeScene } from '../testing/mockFlatApi';
import { viewFacts } from './facts';
import { roomViews } from './views';

/** Reference prompt v2 (restyle spike): the picture's openings and fixed fittings come from the scene; no Haussmann; windowless pictures say so. */

const scene = charmeScene();
const parisian = loadStyles().find((s) => s.meta.id === 'french-parisian')!.meta;
const facts = (room: string, view: string) => viewFacts(scene, room, roomViews(scene, room).find((v) => v.id === view)!.pose);

describe('viewFacts', () => {
  it('lists the openings a camera sees, with side and size, and counts them', () => {
    const f = facts('sejour', 'windows');
    expect(f.openingsText).toMatch(/2 in total \(2 glazed doors\), no other window/);
    expect(f.openingsText).toMatch(/glazed balcony double door, 1\.40 x 2\.05 m, two sashes/);
    expect(f.openingsText).toMatch(/glazed balcony door, 0\.90 x 2\.05 m, a single sash/);
    expect(f.openings.map((o) => o.side)).toEqual([...f.openings.map((o) => o.side)].sort((a, b) => ['LEFT', 'CENTRE', 'RIGHT'].indexOf(a) - ['LEFT', 'CENTRE', 'RIGHT'].indexOf(b)));
    expect(f.windowless).toBe(false);
    expect(f.roomWindowless).toBe(false);
  });

  it('names the fixed fittings in view (the kitchen run, merged, with sides)', () => {
    const f = facts('sejour', 'kitchen');
    expect(f.fittingsText).toMatch(/induction hob/);
    expect(f.fittingsText).toMatch(/sink/);
    expect(f.fittingsText).toMatch(/stainless fridge/);
    expect(f.fittingsText).toMatch(/wall units/);
    // one entry per kind of fitting, not one per unit
    expect(f.fittings.filter((x) => /wall units/.test(x.text))).toHaveLength(1);
  });

  it('a view that looks away from the windows sees none: the picture is windowless but the room is not', () => {
    const f = facts('sejour', 'media');
    expect(f.windowless).toBe(true);
    expect(f.roomWindowless).toBe(false);
    expect(f.fittingsText).toMatch(/55 inch TV/);
  });

  it('the WC and the bathroom have no window anywhere; the WC picture shows the toilet AND the hand basin and the door in the foreground', () => {
    const wc = facts('wc', 'main');
    expect(wc.windowless).toBe(true);
    expect(wc.roomWindowless).toBe(true);
    expect(wc.openings).toHaveLength(1);
    expect(wc.openings[0]).toMatchObject({ kind: 'door', foreground: true });
    expect(wc.fittingsText).toMatch(/toilet/);
    expect(wc.fittingsText).toMatch(/hand basin/);
    const sdb = viewFacts(scene, 'sdb', roomViews(scene, 'sdb')[0]!.pose);
    expect(sdb.roomWindowless).toBe(true);
    expect(sdb.fittingsText).toMatch(/bath screen/);
    expect(sdb.fittingsText).toMatch(/washing machine/);
  });

  it('a camera that is not a walk pose yields no facts', () => {
    const f = viewFacts(scene, 'wc', { mode: 'orbit', target: [0, 0, 0], azimuthDeg: 0, elevationDeg: 30, distance: 5, fovDeg: 50 });
    expect(f.openings).toEqual([]);
    expect(f.fittings).toEqual([]);
  });
});

describe('reference prompt v2', () => {
  it('never says Haussmann (nor a cornice), states the 2.5 m flat ceiling and the modern building, for every style', () => {
    for (const s of loadStyles()) {
      const p = buildReferencePrompt(s.meta, 'living', {});
      expect(p.prompt, s.meta.id).not.toMatch(/haussmann/i);
      expect(p.prompt.replace('without cornice, moulding or ceiling rose', ''), s.meta.id).not.toMatch(/cornice|ceiling rose/i);
      expect(p.prompt).toMatch(/2010s French residential/);
      expect(p.prompt).toMatch(/exactly 2\.5 m/);
      // the negative prompt does name them, to keep them out
      expect(p.negativePrompt).toMatch(/Haussmann/);
      expect(p.negativePrompt).toMatch(/cornice/);
    }
    expect(plainName(parisian)).toBe('French Parisian');
    expect(plain('Haussmann elegance, wall panelling (boiserie) and a ceiling cornice, tone on tone')).toBe('Parisian elegance, wall panelling (boiserie), tone on tone');
    expect(plain('chevron parquet (warm honey; paint material with pattern "chevron")')).toBe('chevron parquet');
  });

  it('every prompt of every view of the flat stays under the 2000 characters the image service accepts, and keeps the openings and fittings', () => {
    for (const s of loadStyles()) {
      for (const room of scene.rooms) {
        for (const v of roomViews(scene, room.id)) {
          const f = viewFacts(scene, room.id, v.pose);
          const p = buildReferencePrompt(s.meta, v.zone === 'kitchen' ? 'kitchen' : room.type, { facts: f, fixedOnly: room.type === 'bathroom', ...(v.zone === 'kitchen' ? { zone: 'kitchen' as const } : {}), viewHint: v.promptHint, layout: 'Layout: the sofa faces the TV wall.' });
          expect(p.prompt.length, `${s.meta.id} ${room.id}/${v.id}`).toBeLessThanOrEqual(1900);
          expect(p.negativePrompt.length).toBeLessThanOrEqual(1900);
          expect(p.prompt).toContain(f.openingsText);
          if (f.fittingsText) expect(p.prompt).toContain(f.fittingsText);
        }
      }
    }
  });

  it('lists the exact openings and fittings of the view', () => {
    const f = facts('sejour', 'kitchen');
    const p = buildReferencePrompt(parisian, 'living', { zone: 'kitchen', facts: f });
    expect(p.prompt).toContain(f.openingsText);
    expect(p.prompt).toContain(f.fittingsText);
    expect(p.prompt).toMatch(/do not add, remove, move, widen or heighten any window or door/);
    expect(p.prompt).not.toMatch(/no window, no skylight/);
    expect(p.negativePrompt).not.toMatch(/skylight/);
  });

  it('a windowless room says no window, no skylight, no extra door, in the prompt and the negatives, and drops curtains', () => {
    const f = facts('wc', 'main');
    const p = buildReferencePrompt(parisian, 'bathroom', { facts: f, fixedOnly: true });
    expect(p.prompt).toMatch(/no window, no skylight and no extra door/);
    expect(p.prompt).toMatch(/lit only by artificial light/);
    // a model told about windows draws one: the word appears once, in the explicit sentence, nowhere else of the geometry text
    expect(p.prompt.match(/window/gi)).toHaveLength(1);
    expect(p.prompt).toMatch(/only its fixed fittings/);
    expect(p.negativePrompt).toMatch(/window, skylight, extra door/);
    expect(p.negativePrompt).toMatch(/vanity, shower, large mirror/);
    const living = buildReferencePrompt(parisian, 'living', { facts: facts('sejour', 'media') });
    expect(living.prompt).toMatch(/no window, no skylight and no extra door in this picture \(the windows of the room are out of frame\)/);
    expect(living.prompt).not.toMatch(/curtains at the windows/);
    expect(living.prompt).not.toMatch(/artificial light/);
  });

  it('a balcony is an outdoor scene: no ceiling height, no windowless rules', () => {
    const f = facts('balcon', 'windows');
    const p = buildReferencePrompt(parisian, 'balcony', { facts: { ...f, windowless: true } });
    expect(p.prompt).not.toMatch(/ceiling exactly 2\.5 m/);
    expect(p.prompt).not.toMatch(/no skylight/);
    expect(p.prompt).toMatch(/balcony of a modern 2010s French/);
    expect(p.negativePrompt).not.toMatch(/skylight/);
  });
});
