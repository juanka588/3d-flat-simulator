import { useId, useState } from 'react';
import { Site } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { useSceneStore } from '../state/sceneStore';

type Draft = Record<'latitude' | 'longitude' | 'northAngle' | 'timezone' | 'floorElevation', string>;
type Errors = Partial<Record<keyof Draft, string>>;

const FIELDS: { key: keyof Draft; label: string; unit?: string; text?: boolean }[] = [
  { key: 'latitude', label: 'Latitude', unit: '°' },
  { key: 'longitude', label: 'Longitude', unit: '°' },
  { key: 'northAngle', label: 'North angle', unit: '°' },
  { key: 'timezone', label: 'Time zone', text: true },
  { key: 'floorElevation', label: 'Floor elevation', unit: 'm' },
];

function draftOf(site: Scene['site']): Draft {
  return {
    latitude: String(site.latitude),
    longitude: String(site.longitude),
    northAngle: String(site.northAngle),
    timezone: site.timezone,
    floorElevation: String(site.floorElevation),
  };
}

const SITE_KEYS = ['latitude', 'longitude', 'northAngle', 'timezone', 'floorElevation'] as const;

/**
 * Edits `scene.site` through `site.set` commands (mount with `key` = scene identity so loading
 * another flat resets the form). Valid edits are applied immediately and are undoable (quick
 * successive edits merge into one step); invalid ones are reported next to the field and not
 * applied. The form follows external changes to the site (undo, redo, remote edits).
 */
export function SitePanel({ scene }: { scene: Scene }) {
  const idPrefix = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(scene.site));
  const [errors, setErrors] = useState<Errors>({});
  const [seenSite, setSeenSite] = useState(scene.site);
  if (seenSite !== scene.site) {
    // The site changed under us. Our own edits leave the draft alone (so half-typed text survives);
    // anything else (undo, redo, remote) resets the form to the new site.
    setSeenSite(scene.site);
    if (SITE_KEYS.some((k) => (k === 'timezone' ? draft[k] !== scene.site[k] : draft[k].trim() === '' || Number(draft[k]) !== scene.site[k]))) {
      setDraft(draftOf(scene.site));
      setErrors({});
    }
  }
  const edit = (key: keyof Draft, value: string) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    const numeric = (s: string) => (s.trim() === '' ? NaN : Number(s));
    const result = Site.safeParse({
      ...scene.site,
      latitude: numeric(next.latitude),
      longitude: numeric(next.longitude),
      northAngle: numeric(next.northAngle),
      timezone: next.timezone,
      floorElevation: numeric(next.floorElevation),
    });
    if (result.success) {
      setErrors({});
      const patch: Partial<Scene['site']> = {};
      for (const k of SITE_KEYS) if (result.data[k] !== scene.site[k]) Object.assign(patch, { [k]: result.data[k] });
      if (Object.keys(patch).length > 0) {
        useSceneStore.getState().dispatch({ type: 'site.set', site: patch }, { coalesceKey: 'site.set', label: 'Edit site' });
      }
      return;
    }
    const found: Errors = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0] as keyof Draft | undefined;
      if (field && field in next && !found[field]) {
        found[field] = Number.isNaN(numeric(next[field])) && field !== 'timezone' ? 'Enter a number' : issue.message;
      }
    }
    setErrors(found);
  };

  return (
    <section aria-label="Site" className="panel site" data-testid="site-panel">
      <h2>Site</h2>
      {FIELDS.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const error = errors[f.key];
        return (
          <div className="field" key={f.key}>
            <label htmlFor={id}>{f.label}</label>
            <input
              id={id}
              data-testid={`site-${f.key}`}
              type={f.text ? 'text' : 'number'}
              step="any"
              value={draft[f.key]}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(e) => edit(f.key, e.target.value)}
            />
            {f.unit && <span className="unit">{f.unit}</span>}
            {error && (
              <p id={`${id}-error`} role="alert" className="field-error">
                {error}
              </p>
            )}
          </div>
        );
      })}
      <p className="hint">Changes apply to the open flat; Ctrl/Cmd+Z undoes them.</p>
    </section>
  );
}
