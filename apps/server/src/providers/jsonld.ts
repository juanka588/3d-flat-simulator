/** schema.org JSON-LD helpers shared by the IKEA and pasted-URL providers. */

export type Json = Record<string, unknown>;

const SCRIPT_RE = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every JSON-LD node of a page (arrays and `@graph` flattened). Blocks that are not valid JSON are skipped and counted. */
export function extractJsonLd(html: string): { nodes: Json[]; blocks: number; invalid: number } {
  const nodes: Json[] = [];
  let blocks = 0;
  let invalid = 0;
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isObj(v)) {
      nodes.push(v);
      if (v['@graph']) visit(v['@graph']);
    }
  };
  for (const m of html.matchAll(SCRIPT_RE)) {
    blocks++;
    try {
      visit(JSON.parse(m[1]!.trim()));
    } catch {
      invalid++;
    }
  }
  return { nodes, blocks, invalid };
}

export function hasType(node: Json, type: string): boolean {
  const t = node['@type'];
  return t === type || (Array.isArray(t) && t.includes(type));
}

export const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** A price from `"59.99"`, `59.99` or `"59,99"`. */
export function asPrice(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export { isObj };
