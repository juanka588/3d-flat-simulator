import { parseScene } from './parse';
import type { Scene } from './schema';
import { validateScene, type ValidationWarning } from './validate';

/** Largest accepted scene file, in bytes. */
export const MAX_SCENE_BYTES = 5 * 1024 * 1024;

export type LoadResult =
  | { ok: true; scene: Scene; warnings: ValidationWarning[] }
  | { ok: false; errors: string[] };

/**
 * Parses the text of a `.flat.json` file into a validated Scene.
 * Errors are human-readable: JSON syntax errors carry `line L, column C`, schema errors
 * carry paths such as `walls[2].thickness: ...`. Warnings come from `validateScene`.
 */
export function loadSceneText(text: string): LoadResult {
  if (text.length > MAX_SCENE_BYTES || (text.length * 3 > MAX_SCENE_BYTES && byteLength(text) > MAX_SCENE_BYTES)) {
    return { ok: false, errors: [`file is larger than ${MAX_SCENE_BYTES / 1024 / 1024} MB`] };
  }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (source.trim() === '') return { ok: false, errors: ['file is empty'] };

  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { line, column } = locate(source, message);
    return { ok: false, errors: [`invalid JSON at line ${line}, column ${column}: ${message}`] };
  }

  const parsed = parseScene(data);
  if (!parsed.ok) return parsed;
  return { ok: true, scene: parsed.scene, warnings: validateScene(parsed.scene).warnings };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Engines word syntax errors differently (newer V8 may omit the position entirely), so the
 * position comes from a small strict JSON scanner that finds the first error offset.
 */
function locate(text: string, message: string): { line: number; column: number } {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  const offset = pos ? Math.min(Number(pos[1]), text.length) : firstJsonErrorOffset(text);
  const before = text.slice(0, offset);
  return { line: before.split('\n').length, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

/** Offset of the first character that makes `text` invalid JSON (text.length when truncated). */
export function firstJsonErrorOffset(text: string): number {
  let i = 0;
  const fail = (at = i): never => {
    throw at;
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const literal = (word: string) => {
    for (const ch of word) {
      if (text[i] !== ch) fail();
      i++;
    }
  };
  const string = () => {
    i++; // opening quote
    for (;;) {
      const ch = text[i];
      if (ch === undefined) fail(text.length);
      if (ch === '"') break;
      if (ch! < ' ') fail();
      if (ch === '\\') {
        i++;
        const esc = text[i];
        if (esc === 'u') {
          for (let k = 1; k <= 4; k++) if (!/[0-9a-fA-F]/.test(text[i + k] ?? '')) fail(i + k);
          i += 4;
        } else if (esc === undefined || !'"\\/bfnrt'.includes(esc)) fail();
      }
      i++;
    }
    i++;
  };
  const number = () => {
    if (text[i] === '-') i++;
    if (text[i] === '0') i++;
    else if (/[1-9]/.test(text[i] ?? '')) while (/[0-9]/.test(text[i] ?? '')) i++;
    else fail();
    if (text[i] === '.') {
      i++;
      if (!/[0-9]/.test(text[i] ?? '')) fail();
      while (/[0-9]/.test(text[i] ?? '')) i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!/[0-9]/.test(text[i] ?? '')) fail();
      while (/[0-9]/.test(text[i] ?? '')) i++;
    }
  };
  const value = (): void => {
    ws();
    const ch = text[i];
    if (ch === undefined) fail(text.length);
    if (ch === '{') {
      i++;
      ws();
      if (text[i] === '}') return void i++;
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        string();
        ws();
        if (text[i] !== ':') fail();
        i++;
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') return void i++;
        else fail();
      }
    } else if (ch === '[') {
      i++;
      ws();
      if (text[i] === ']') return void i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') return void i++;
        else fail();
      }
    } else if (ch === '"') string();
    else if (ch === 't') literal('true');
    else if (ch === 'f') literal('false');
    else if (ch === 'n') literal('null');
    else number();
  };
  try {
    value();
    ws();
    return i < text.length ? i : text.length;
  } catch (at) {
    return typeof at === 'number' ? Math.min(at, text.length) : text.length;
  }
}
