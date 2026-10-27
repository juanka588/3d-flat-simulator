/**
 * Luminous flux (lumens) of a lamp from a product page's text, if the page states it (M5.21). Pure: no network.
 *
 * IKEA France lists the bulb in the specification: "Flux lumineux: 806 lumen", "Ampoule LED E27 806 lumen",
 * "806 lm", sometimes with a thin or no-break space as thousands separator ("1 055 lm"). The first plausible
 * figure wins; a label ("flux lumineux", "luminous flux", "lumens:") beats a bare "<n> lm".
 */

const MIN_LUMENS = 20;
const MAX_LUMENS = 30_000;

const toNumber = (digits: string): number | undefined => {
  const n = Number(digits.replace(/[\s\u00a0\u202f.,]/g, ''));
  return Number.isFinite(n) && n >= MIN_LUMENS && n <= MAX_LUMENS ? n : undefined;
};

const NUMBER = '(?<![\\w.,])(\\d{1,2}(?:[\\s\\u00a0\\u202f.,]\\d{3})+|\\d{2,5})';
/** "flux lumineux : 806 lumen", "lumens: 806", "luminous flux 806". */
const LABELLED = new RegExp(`(?:flux\\s+lumineux|luminous\\s+flux|lumens?)\\s*(?:\\([^)]*\\))?\\s*[:=]?\\s*${NUMBER}`, 'i');
/** "806 lm", "806 lumen(s)". */
const UNIT = new RegExp(`${NUMBER}\\s*(?:lm|lumens?)\\b`, 'i');

/** The bulb's luminous flux in lumens, or `undefined` when the text does not state one. */
export function parseLumens(text: string): number | undefined {
  const flat = text.replace(/\s+/g, ' ');
  for (const re of [LABELLED, UNIT]) {
    const m = re.exec(flat);
    const n = m?.[1] !== undefined ? toNumber(m[1]) : undefined;
    if (n !== undefined) return n;
  }
  return undefined;
}

/** Visible text of an HTML page: scripts and styles dropped, tags replaced by spaces, entities for spaces decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&');
}
