import { SiteContext } from '@flat/scene';

// Context files are generated offline (tools/site-context) next to the fixtures. They may be
// absent, so they are discovered with a glob rather than imported by name.
const files = import.meta.glob('../../../../packages/scene/fixtures/*.context.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const cache = new Map<string, SiteContext | null>();

/** Site context for a fixture id (e.g. `charme-3205`), or null when none exists or it is invalid. */
export function contextFor(fixtureId: string): SiteContext | null {
  if (cache.has(fixtureId)) return cache.get(fixtureId) ?? null;
  const key = Object.keys(files).find((k) => k.endsWith(`/${fixtureId}.context.json`));
  const parsed = key ? SiteContext.safeParse(files[key]) : null;
  const context = parsed?.success ? parsed.data : null;
  if (parsed && !parsed.success) console.warn(`invalid site context for ${fixtureId}`, parsed.error.issues.slice(0, 3));
  cache.set(fixtureId, context);
  return context;
}
