import { ProductRecord } from '@flat/assets';
import { describe, expect, it } from 'vitest';
import { PASTED_URL_META } from './catalog';
import { BLOCKED_MESSAGE, createPastedUrlProvider, quantityToMetres, urlHash, validatePastedUrl } from './pasted-url';
import { isPrivateAddress } from './ssrf';
import { collect, fixture, status, testContext, text, tinyGlb } from './testkit';
import { parseLength, parseMeasureText } from './units';

const PAGE = 'https://www.meubles-exemple.fr/p/lit-malmo';
const publicDns = async () => ['93.184.216.34'];
const ctxFor = (routes: Parameters<typeof testContext>[0], lookup: (h: string) => Promise<string[]> = publicDns) =>
  testContext(routes, { id: 'pasted-url', scope: 'host', lookup });

describe('pasted-url: schema.org parsing', () => {
  it('reads Product with unit conversion (CMT, "207 cm", mm) and the 3DModel', async () => {
    const t = ctxFor([[PAGE, text(fixture('pasted-url/with-dims.html'))]]);
    const rec = await createPastedUrlProvider().resolveUrl!(PAGE, t.ctx);
    expect(ProductRecord.safeParse(rec).success).toBe(true);
    expect(rec).toMatchObject({
      provider: 'pasted-url',
      sku: urlHash(PAGE),
      name: 'Lit coffre MALMO 160x200',
      price: 349,
      currency: 'EUR',
      dims: { w: 1.65, d: 2.07, h: 0.35 },
      dimsSource: 'structured',
      category: 'bed',
      modelRef: 'https://assets.meubles-exemple.fr/models/malmo.glb',
    });
    expect(rec.sku).toMatch(/^[0-9a-f]{16}$/);
    // cached for an hour: no second request
    const n = t.fetch.calls.length;
    await createPastedUrlProvider().resolveUrl!(PAGE, t.ctx);
    expect(t.fetch.calls).toHaveLength(n);
  });

  it('missing dims -> product_dims_missing with a draft the UI can prefill', async () => {
    const t = ctxFor([[PAGE, text(fixture('pasted-url/without-dims.html'))]]);
    await expect(createPastedUrlProvider().resolveUrl!(PAGE, t.ctx)).rejects.toMatchObject({
      code: 'product_dims_missing',
      details: { missing: ['depth', 'height'], knownDims: { w: 2.1 }, draft: { name: 'Canapé 3 places ORSA', price: 599, currency: 'EUR' } },
    });
  });

  it('a page without JSON-LD -> provider_parse_failed; a bot challenge -> provider_blocked', async () => {
    const t = ctxFor([[PAGE, text(fixture('pasted-url/no-jsonld.html'))]]);
    await expect(createPastedUrlProvider().resolveUrl!(PAGE, t.ctx)).rejects.toMatchObject({ code: 'provider_parse_failed' });
    const t2 = ctxFor([[PAGE, text(fixture('pasted-url/challenge.html'))]]);
    await expect(createPastedUrlProvider().resolveUrl!(PAGE, t2.ctx)).rejects.toMatchObject({ code: 'provider_blocked' });
  });

  it('403 -> provider_blocked with the user message; only that site is paused', async () => {
    const t = ctxFor([['https://www.leroy-exemple.fr/p/x', status(403)], [PAGE, text(fixture('pasted-url/with-dims.html'))]]);
    const p = createPastedUrlProvider();
    const e = await p.resolveUrl!('https://www.leroy-exemple.fr/p/x', t.ctx).catch((x) => x);
    expect(e).toMatchObject({ code: 'provider_blocked', message: BLOCKED_MESSAGE });
    expect(BLOCKED_MESSAGE).toBe('This site blocks automated reads; enter the details by hand or pick another product');
    expect((await p.resolveUrl!(PAGE, t.ctx)).name).toMatch(/MALMO/);
  });

  it('404, non-HTML and oversize pages', async () => {
    const p = createPastedUrlProvider();
    expect(await p.resolveUrl!(PAGE, ctxFor([[PAGE, status(404)]]).ctx).catch((x) => x.code)).toBe('product_not_found');
    expect(await p.resolveUrl!(PAGE, ctxFor([[PAGE, text('x', 200, 'application/pdf')]]).ctx).catch((x) => x.code)).toBe('url_not_allowed');
    expect(await p.resolveUrl!(PAGE, ctxFor([[PAGE, text('x'.repeat(2 * 1024 * 1024 + 1))]]).ctx).catch((x) => x.code)).toBe('url_not_allowed');
  });

  it('robots.txt disallow is honoured before the page request', async () => {
    const t = ctxFor([['https://www.meubles-exemple.fr/robots.txt', text('User-agent: *\nDisallow: /p/\n', 200, 'text/plain')]]);
    await expect(createPastedUrlProvider().resolveUrl!(PAGE, t.ctx)).rejects.toMatchObject({ code: 'robots_disallowed' });
    expect(t.fetch.pages()).toHaveLength(0);
  });

  it('streams the page 3D model through the same guard', async () => {
    const t = ctxFor([[PAGE, text(fixture('pasted-url/with-dims.html'))], ['https://assets.meubles-exemple.fr/models/malmo.glb', new Response(tinyGlb(), { headers: { 'content-type': 'model/gltf-binary' } })]]);
    const p = createPastedUrlProvider();
    const rec = await p.resolveUrl!(PAGE, t.ctx);
    const m = await p.fetchModel!(rec.sku, t.ctx);
    expect(new TextDecoder().decode((await collect(m.stream)).slice(0, 4))).toBe('glTF');
    await expect(p.fetchModel!('unknown', t.ctx)).rejects.toMatchObject({ code: 'model_unavailable' });
  });

  it('unit helpers', () => {
    expect(parseLength('76,5 cm')).toBe(0.765);
    expect(parseLength('800 mm')).toBe(0.8);
    expect(parseLength('2 m')).toBe(2);
    expect(parseLength('12 in')).toBe(0.305);
    expect(parseLength('160')).toBeUndefined(); // no unit: refused, not guessed
    expect(quantityToMetres({ value: 160, unitCode: 'CMT' })).toBe(1.6);
    expect(quantityToMetres({ value: 160 })).toBeUndefined();
    expect(parseMeasureText('77x147 cm')).toEqual([0.77, 1.47]);
    expect(parseMeasureText('hello')).toEqual([]);
  });

  it('declares the static catalog entry', () => {
    const p = createPastedUrlProvider();
    expect([p.id, p.capabilities, p.personalUseOnly]).toEqual([PASTED_URL_META.id, PASTED_URL_META.capabilities, PASTED_URL_META.personalUseOnly]);
  });
});

describe('pasted-url: SSRF guard', () => {
  const p = createPastedUrlProvider();
  const reject = async (url: string, lookup?: (h: string) => Promise<string[]>, routes: Parameters<typeof testContext>[0] = []) => {
    const t = ctxFor(routes, lookup);
    const e = await p.resolveUrl!(url, t.ctx).catch((x) => x);
    expect(e).toMatchObject({ code: 'url_not_allowed' });
    expect(t.fetch.pages()).toHaveLength(0);
    return e as Error;
  };

  it('refuses file://, http://, other ports, credentials and junk before any request', async () => {
    await reject('file:///etc/passwd');
    await reject('http://www.meubles-exemple.fr/p');
    await reject('https://www.meubles-exemple.fr:8443/p');
    await reject('https://user:pw@www.meubles-exemple.fr/p');
    await reject('not a url');
    await reject('ftp://x.example/a');
  });

  it('refuses loopback / private literals and local names', async () => {
    await reject('https://127.0.0.1/p');
    await reject('https://[::1]/p');
    await reject('https://10.0.0.5/p');
    await reject('https://169.254.169.254/latest/meta-data');
    await reject('https://2130706433/p'); // decimal form of 127.0.0.1
    await reject('https://localhost/p');
    await reject('https://printer.local/p');
    await reject('https://[::ffff:127.0.0.1]/p');
  });

  it('refuses a public name that resolves to a private address (also when mixed with public ones)', async () => {
    expect((await reject('https://shop.example/p', async () => ['10.1.2.3'])).message).toMatch(/private/);
    await reject('https://shop.example/p', async () => ['93.184.216.34', '192.168.1.10']);
    await reject('https://shop.example/p', async () => ['fd00::1']);
    await reject('https://shop.example/p', async () => []);
  });

  it('a redirect to a private host, to another host, or to http is refused without following it', async () => {
    const t = ctxFor([
      ['https://shop.example/a', status(302, { location: 'https://127.0.0.1/admin' })],
      ['https://shop.example/b', status(302, { location: 'https://other.example/x' })],
      ['https://shop.example/c', status(302, { location: 'http://shop.example/x' })],
      ['https://shop.example/d', status(302, { location: 'https://www.shop.example/ok' })],
      ['https://www.shop.example/ok', text(fixture('pasted-url/with-dims.html'))],
    ]);
    for (const path of ['a', 'b', 'c']) {
      await expect(p.resolveUrl!(`https://shop.example/${path}`, t.ctx)).rejects.toMatchObject({ code: 'url_not_allowed' });
    }
    expect(t.fetch.calls.some((c) => c.url.includes('127.0.0.1') || c.url.includes('other.example') || c.url.startsWith('http://'))).toBe(false);
    expect((await p.resolveUrl!('https://shop.example/d', t.ctx)).name).toMatch(/MALMO/);
  });

  it('a redirect whose target resolves to a private IP after DNS is refused', async () => {
    const t = ctxFor(
      [['https://shop.example/a', status(302, { location: 'https://www.shop.example/in' })]],
      async (h) => (h === 'www.shop.example' ? ['127.0.0.1'] : ['93.184.216.34']),
    );
    await expect(p.resolveUrl!('https://shop.example/a', t.ctx)).rejects.toMatchObject({ code: 'url_not_allowed' });
    expect(t.fetch.pages().map((c) => c.url)).toEqual(['https://shop.example/a']);
  });

  it('classifies addresses', () => {
    for (const ip of ['0.0.0.0', '127.0.0.1', '10.1.1.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '100.64.0.1', '224.0.0.1', '::', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'garbage']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('validatePastedUrl drops the fragment', () => {
    expect(validatePastedUrl('https://a.example/p#frag').href).toBe('https://a.example/p');
    expect(urlHash('https://a.example/p#1')).toBe(urlHash('https://a.example/p#2'));
  });
});
