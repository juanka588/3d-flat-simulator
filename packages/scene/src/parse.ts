import type { z } from 'zod';
import { Scene } from './schema';

export type ParseResult = { ok: true; scene: Scene } | { ok: false; errors: string[] };

/** Most errors `parseScene` reports before summarising the rest. */
export const MAX_ERRORS = 50;

/** Validates unknown JSON as a Scene, returning human-readable errors like `walls[2].thickness: ...`. */
export function parseScene(input: unknown): ParseResult {
  const result = Scene.safeParse(input);
  if (result.success) return { ok: true, scene: result.data };
  const issues = result.error.issues;
  const errors = issues.slice(0, MAX_ERRORS).map(formatIssue);
  if (issues.length > MAX_ERRORS) errors.push(`…and ${issues.length - MAX_ERRORS} more errors`);
  return { ok: false, errors };
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path
    .map((part, i) => (typeof part === 'number' ? `[${part}]` : i === 0 ? String(part) : `.${String(part)}`))
    .join('');
  return path ? `${path}: ${issue.message}` : issue.message;
}
