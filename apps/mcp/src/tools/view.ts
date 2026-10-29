import { LightingView, PresetName, applyPreset, localToInstant, sunAtInstant } from '@flat/scene';
import { z } from 'zod';
import { apiFailure, toolError, toolOk } from '../errors';
import { effectiveSessionLighting, sessionLighting } from '../readModel';
import { READ, fetchScene, obj, parseArgs } from './common';
import { RealDate } from './read';
import { LAMP_MODES, type LampMode, type ToolDef } from './registry';

/** For the render service: the lighting of a session over a scene, with the lamp mode applied to the scene's current lights. */
export { effectiveSessionLighting } from '../readModel';

/**
 * View tools. `set_sun_time` (M4.11) changes the MCP SESSION's lighting view only (date, time,
 * preset): not the flat, not undoable. Later `describe_room` and `render_view` calls use it. With
 * `sync_to_user_tab` the same lighting is relayed to the user's open tab (`POST /api/view`), which
 * applies it only while "Follow assistant view" is on there. `render_view` lives in `render.ts` (lane E).
 */

/** What each preset sets (see `applyPreset`). */
const PRESET_KEYS: Record<z.infer<typeof PresetName>, (keyof LightingView)[]> = {
  day: ['time', 'sunEnabled', 'lamps'],
  evening: ['date', 'time', 'sunEnabled', 'lamps'],
  night: ['time', 'sunEnabled', 'lamps'],
};

const SunArgs = z.strictObject({
  date: RealDate.optional(),
  time: LightingView.shape.time.optional(),
  preset: PresetName.optional(),
  lamps: z.enum(LAMP_MODES).optional(),
  sync_to_user_tab: z.boolean().optional(),
});

/** The wall-clock `HH:mm` of an instant in a time zone. */
function wallTime(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

export function viewTools(): ToolDef[] {
  return [
    {
      name: 'set_sun_time',
      description:
        'Set the session\'s date, time or lighting preset (day / evening / night) used by later describe_room and render_view calls. It does not change the flat and is not undoable. Times are local at the flat (its time zone, DST aware). sync_to_user_tab also shows it in the user\'s open tab.',
      inputSchema: obj({
        date: { type: 'string', description: 'Local date YYYY-MM-DD at the flat.' },
        time: { type: 'string', description: 'Local time HH:mm at the flat.' },
        preset: { type: 'string', enum: ['day', 'evening', 'night'], description: 'day: 12:00 sun, lamps off. evening: 20:00 on 21 Dec, lamps on. night: 23:00, no sun, lamps on. Applied first; date and time then override it.' },
        lamps: { type: 'string', enum: [...LAMP_MODES], description: 'scene: lamps follow the flat. allOn / allOff: force every lamp on / off. A preset sets it (day: allOff; evening, night: allOn) until you change it; "scene" goes back to the flat\'s own lamp states.' },
        sync_to_user_tab: { type: 'boolean', description: 'true: also relay this lighting to the user\'s open tab (shown only if they follow the assistant view).' },
      }),
      annotations: { ...READ, idempotentHint: true },
      group: 'view',
      mutatesScene: false,
      async handler(ctx, args) {
        const a = parseArgs(SunArgs, args);
        if (!a.ok) return a.result;
        const { date, time, preset, lamps: lampsArg, sync_to_user_tab: sync } = a.data;
        const sc = await fetchScene(ctx);
        if (!sc.ok) return sc.result;
        const { site, lights } = sc.data.scene;

        let next = sessionLighting(ctx.session);
        // Keys this call sets. Only these travel to the user's tab: a time-only call must not reset
        // the tab's lamps, exposure or sun switch (the relay is a partial update).
        const touched = new Set<keyof LightingView>();
        if (preset) {
          next = applyPreset(next, preset, site, lights);
          for (const k of PRESET_KEYS[preset]) touched.add(k);
        }
        let mode: LampMode = ctx.session.lampMode;
        if (preset) mode = preset === 'day' ? 'allOff' : 'allOn';
        if (lampsArg) {
          mode = lampsArg;
          touched.add('lamps');
        }
        // The mode is the truth; `lamps` mirrors it for the current lights (and is what the tab receives).
        next = effectiveSessionLighting({ lighting: next, lampMode: mode }, { lights });
        if (date) {
          next = { ...next, date };
          touched.add('date');
        }
        if (time) {
          next = { ...next, time };
          touched.add('time');
        }
        const valid = LightingView.safeParse(next);
        if (!valid.success) return toolError('invalid_command', valid.error.issues.map((i) => `${i.path.join('/')}: ${i.message}`).join('; '));
        next = valid.data;

        let instant: Date;
        try {
          instant = localToInstant(next.date, next.time, site.timezone);
        } catch (e) {
          return toolError('invalid_command', `cannot resolve ${next.date} ${next.time} in ${site.timezone}: ${e instanceof Error ? e.message : String(e)}`);
        }
        const resolved = wallTime(instant, site.timezone);
        if (resolved !== next.time) {
          return toolError('invalid_command', `${next.date} ${next.time} does not exist in ${site.timezone} (clocks jump forward); the next valid time is ${resolved}`, `Use ${resolved} or another time.`, {
            errors: [{ code: 'invalid_command', path: 'time', message: `local time ${next.time} falls in a daylight-saving gap on ${next.date}` }],
          });
        }

        ctx.session.lighting = next;
        ctx.session.lampMode = mode;
        if (sync !== undefined) ctx.session.syncToUserTab = sync;
        const sun = sunAtInstant(site, instant);

        let synced: Record<string, unknown> | undefined;
        if (ctx.session.syncToUserTab) {
          const delta: Partial<LightingView> = {};
          for (const k of touched) (delta as Record<string, unknown>)[k] = next[k];
          // nothing touched (a bare sync request): send the whole session state
          const r = await ctx.flat.postView({ lighting: touched.size ? delta : next, from: ctx.session.clientName.slice(0, 200) });
          const failure = r.ok ? undefined : apiFailure(r).structuredContent;
          synced = r.ok ? { ok: true, delivered: r.data.delivered } : { ok: false, code: (failure as { code?: string } | undefined)?.code ?? 'internal_error', message: (failure as { message?: string } | undefined)?.message ?? 'relay failed' };
        }

        return toolOk({
          ok: true,
          lighting: { date: next.date, time: next.time, sunEnabled: next.sunEnabled, exposureEV: next.exposureEV, lamps: next.lamps },
          lampMode: mode,
          ...(mode === 'scene' ? {} : { note: `lamps are forced ${mode === 'allOn' ? 'on' : 'off'} for describe_room and render_view (light_update on/off is hidden until you call set_sun_time with lamps "scene")` }),
          timezone: site.timezone,
          utc: instant.toISOString(),
          sun: { isUp: sun.isUp, altitudeDeg: Math.round(sun.altitudeDeg * 10) / 10, azimuthDeg: Math.round(sun.azimuthDeg) },
          ...(synced ? { syncedToUserTab: synced } : {}),
        });
      },
    },
  ];
}
