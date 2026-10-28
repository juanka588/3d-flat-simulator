import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MCP_ERROR_CODES, MCP_ERROR_HINTS, McpToolError } from './mcp-types';
import { PROVIDER_ERROR_CODES, PROVIDER_ERROR_HINTS, ProductId, formatProductId, parseProductId } from './products';

describe('ProductId', () => {
  it('formats and parses', () => {
    expect(formatProductId({ provider: 'ikea-fr', sku: '80275887' })).toBe('ikea-fr:80275887');
    expect(parseProductId('mock:MOCK-BED-160')).toEqual({ provider: 'mock', sku: 'MOCK-BED-160' });
  });

  it('splits at the first colon only', () => {
    expect(parseProductId('mock:a:b')).toEqual({ provider: 'mock', sku: 'a:b' });
  });

  it.each(['', 'nocolon', ':sku', 'mock:', 'Mock:sku', 'mo ck:sku', 'mock:line\nbreak', `mock:${'x'.repeat(65)}`])('rejects %j', (id) => {
    expect(parseProductId(id)).toBeUndefined();
    expect(ProductId.safeParse(id).success).toBe(false);
  });

  it('round-trips for any valid provider and sku (property)', () => {
    const provider = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,31}$/);
    // eslint-disable-next-line no-control-regex -- control characters are the point
    const sku = fc.string({ minLength: 1, maxLength: 64 }).filter((s) => !new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]').test(s));
    fc.assert(
      fc.property(provider, sku, (p, s) => {
        const id = formatProductId({ provider: p, sku: s });
        expect(ProductId.safeParse(id).success).toBe(true);
        expect(parseProductId(id)).toEqual({ provider: p, sku: s });
      }),
    );
  });

  it('formatProductId refuses invalid parts', () => {
    expect(() => formatProductId({ provider: 'Bad', sku: 'x' })).toThrow(RangeError);
    expect(() => formatProductId({ provider: 'ok', sku: '' })).toThrow(RangeError);
  });
});


describe('provider error codes', () => {
  it('are in the MCP error table with a hint each, additively', () => {
    for (const code of PROVIDER_ERROR_CODES) {
      expect(MCP_ERROR_CODES).toContain(code);
      expect(MCP_ERROR_HINTS[code]).toBe(PROVIDER_ERROR_HINTS[code]);
      expect(PROVIDER_ERROR_HINTS[code].length).toBeGreaterThan(10);
    }
    expect(MCP_ERROR_CODES.slice(0, 6)).toEqual(['invalid_command', 'unknown_entity', 'unknown_material', 'limit_exceeded', 'precondition_failed', 'not_supported']);
    expect(MCP_ERROR_CODES).toContain('internal_error');
    const body = { ok: false, code: 'product_not_seen', message: 'm', hint: PROVIDER_ERROR_HINTS.product_not_seen };
    expect(McpToolError.safeParse(body).success).toBe(true);
  });
});
