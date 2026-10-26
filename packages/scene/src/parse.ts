import type { z } from 'zod';
import { Scene } from './schema';

export type ParseResult = { ok: true; scene: Scene } | { ok: false; errors: string[] };

/** Validates unknown JSON as a Scene, returning human-readable errors like `walls[2].thickness: ...`. */
export function parseScene(input: unknown): ParseResult {
  const result = Scene.safeParse(input);
  if (result.success) return { ok: true, scene: result.data };
  return { ok: false, errors: result.error.issues.map(formatIssue) };
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path
    .map((part, i) => (typeof part === 'number' ? `[${part}]` : i === 0 ? String(part) : `.${String(part)}`))
    .join('');
  return path ? `${path}: ${issue.message}` : issue.message;
}
