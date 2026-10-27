/** Length units -> metres. Keys are lower-case unit words or UN/CEFACT codes. */
const TO_METRES: Record<string, number> = {
  mm: 0.001,
  mmt: 0.001,
  millimetre: 0.001,
  millimeter: 0.001,
  millimètre: 0.001,
  cm: 0.01,
  cmt: 0.01,
  centimetre: 0.01,
  centimeter: 0.01,
  centimètre: 0.01,
  centimètres: 0.01,
  m: 1,
  mtr: 1,
  metre: 1,
  meter: 1,
  mètre: 1,
  in: 0.0254,
  inh: 0.0254,
  inch: 0.0254,
  inches: 0.0254,
  '"': 0.0254,
  ft: 0.3048,
  fot: 0.3048,
  foot: 0.3048,
  feet: 0.3048,
};

export function unitFactor(unit: string | undefined): number | undefined {
  if (unit === undefined) return undefined;
  return TO_METRES[unit.trim().toLowerCase().replace(/\.$/, '')];
}

const round = (m: number) => Math.round(m * 1000) / 1000;

/**
 * `"76.5 cm"`, `"146,5 cm"`, `"1.2 m"`, `"800 mm"` -> metres (rounded to 1 mm). A number without a unit uses
 * `defaultUnit` when given, otherwise it is refused (`undefined`): guessing units would size furniture wrongly.
 */
export function parseLength(text: string, defaultUnit?: string): number | undefined {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Zèé"]+\.?)?\s*$/.exec(text);
  if (!m) return undefined;
  const value = Number(m[1]!.replace(',', '.'));
  const factor = unitFactor(m[2] ?? defaultUnit);
  if (!Number.isFinite(value) || factor === undefined) return undefined;
  return round(value * factor);
}

/** A number plus a separate unit (`value: 160, unitCode: "CMT"`). */
export function lengthOf(value: number, unit: string | undefined): number | undefined {
  const factor = unitFactor(unit);
  return factor === undefined || !Number.isFinite(value) ? undefined : round(value * factor);
}

/** `"77x147 cm"` / `"140×200×30 cm"` -> the numbers in metres, in the written order (empty when not a measure). */
export function parseMeasureText(text: string, defaultUnit = 'cm'): number[] {
  const m = /^\s*(\d+(?:[.,]\d+)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)*)\s*([a-zA-Z]+)?\s*$/.exec(text);
  if (!m) return [];
  const factor = unitFactor(m[2] ?? defaultUnit);
  if (factor === undefined) return [];
  return m[1]!.split(/\s*[x×]\s*/).map((n) => round(Number(n.replace(',', '.')) * factor));
}
