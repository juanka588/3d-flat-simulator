import { SiteContext } from '@flat/scene';

/**
 * Checks `ctx` against scene's zod `SiteContext` schema (the single source of truth; the hand copy that used to live
 * in the tool is gone). Returns a list of problems, empty when valid.
 */
export function validateContext(ctx: unknown): string[] {
  const parsed = SiteContext.safeParse(ctx);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => `${issue.path.length ? issue.path.join('.') : '(context)'}: ${issue.message}`);
}
