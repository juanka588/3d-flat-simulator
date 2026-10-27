import { ProductRecord, productSnapshot } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { parseProductPage } from './ikea-fr';
import { htmlToText, parseLumens } from './lumens';
import { fixture } from './testkit';

describe('parseLumens', () => {
  it('reads labelled and bare figures, with thousands separators', () => {
    expect(parseLumens('Flux lumineux : 806 lumen')).toBe(806);
    expect(parseLumens('Luminous flux 470 lm')).toBe(470);
    expect(parseLumens('Lumens: 1 055')).toBe(1055);
    expect(parseLumens('Ampoule LED E27 806 lumen, 2700 K')).toBe(806);
    expect(parseLumens('1 521 lm')).toBe(1521);
    expect(parseLumens('1,055 lumens')).toBe(1055);
  });

  it('does not take a socket or a wattage for a flux, and returns undefined when none is stated', () => {
    expect(parseLumens('Douille E27, 60 W')).toBeUndefined();
    expect(parseLumens('Ampoule E14 non incluse')).toBeUndefined();
    expect(parseLumens('5 lm')).toBeUndefined(); // below the plausible range
    expect(parseLumens('')).toBeUndefined();
  });

  it('a label beats a bare figure', () => {
    expect(parseLumens('ampoule 806 lumen. Flux lumineux : 1 055 lumen')).toBe(1055);
  });

  it('htmlToText drops scripts and tags', () => {
    expect(htmlToText('<script>var lm = 999 lm</script><p>400&nbsp;lm</p>').replace(/\s+/g, ' ').trim()).toBe('400 lm');
  });
});

describe('IKEA FR lamp page', () => {
  const html = fixture('ikea-fr/product-lamp-10419281.html');
  const opts = { sku: '10419281', pageUrl: 'https://www.ikea.com/fr/fr/p/lampadaire-noir-10419281/', fetchedAt: '2026-10-27T10:00:00.000Z' };

  it('puts the stated flux on the record (category lamp) and in the placed snapshot', () => {
    const rec = parseProductPage(html, opts);
    expect(ProductRecord.safeParse(rec).success).toBe(true);
    expect(rec).toMatchObject({ category: 'lamp', dims: { w: 0.25, d: 0.25, h: 1.5 }, lumens: 1055 });
    expect(productSnapshot(rec, '2026-10-27T10:00:00.000Z').lumens).toBe(1055);
  });

  it('leaves lumens out when the page does not state one, and for products that are not lamps', () => {
    const none = html.replace(/<div class="spec">[\s\S]*<\/div>/, '');
    expect(parseProductPage(none, opts).lumens).toBeUndefined();
    const shelf = parseProductPage(fixture('ikea-fr/product-kallax-80275887.html').replace('</body>', '<p>500 lm</p></body>'), { ...opts, sku: '80275887' });
    expect(shelf.category).toBe('shelf');
    expect(shelf.lumens).toBeUndefined();
  });
});
