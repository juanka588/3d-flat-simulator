import { useId } from 'react';
import { applyPreset, lightFixtureCount, lightLumens } from '@flat/scene';
import type { LampOverride, Light, PresetName, Scene } from '@flat/scene';
import { SPEEDS, useClockStore } from '../state/dayClock';
import { fromMinutes, instantToLocal, toMinutes } from '../state/localTime';
import { sunInfoFor } from '../state/sunInfo';
import { WALK_LIGHTS_EV } from '../state/effectiveLighting';
import { useSceneStore } from '../state/sceneStore';
import { useViewStore } from '../state/viewStore';
import type { BuildingMode } from '@flat/viewer';
import { NumberField } from './NumberField';

const PRESETS: { id: PresetName; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'evening', label: 'Evening' },
  { id: 'night', label: 'Night' },
];

const STEP_MINUTES = 5;

interface LightingPanelProps {
  scene: Scene;
  /** Whether site context (neighbouring buildings) exists for the loaded flat. */
  hasContext: boolean;
}

export function LightingPanel({ scene, hasContext }: LightingPanelProps) {
  const lighting = useViewStore((s) => s.lighting);
  const setLighting = useViewStore((s) => s.setLighting);
  const buildingMode = useViewStore((s) => s.buildingMode);
  const setBuildingMode = useViewStore((s) => s.setBuildingMode);
  const walkLightsOn = useViewStore((s) => s.walkLightsOn);
  const setWalkLightsOn = useViewStore((s) => s.setWalkLightsOn);
  // While walking with the preference on, the viewer lights every lamp (see effectiveLighting): the stored toggles are kept, just not shown as editable.
  const walkOverride = useViewStore((s) => s.mode === 'walk') && walkLightsOn;
  const { playing, speed, setPlaying, setSpeed } = useClockStore();
  const ids = { date: useId(), time: useId(), clock: useId(), ev: useId(), building: useId() };
  const info = sunInfoFor(scene, lighting);

  const current = toMinutes(lighting.time);
  // Slider spans the daylight range; it widens (never narrows) to keep the current time reachable.
  const lo = info.available ? Math.floor(toMinutes(info.rangeStart) / STEP_MINUTES) * STEP_MINUTES : 0;
  const hi = info.available ? Math.ceil(toMinutes(info.rangeEnd) / STEP_MINUTES) * STEP_MINUTES : 1439;
  const min = Math.min(lo, Math.floor(current / STEP_MINUTES) * STEP_MINUTES);
  const max = Math.max(hi, Math.ceil(current / STEP_MINUTES) * STEP_MINUTES);

  const setLamp = (id: string, patch: LampOverride) =>
    setLighting({ lamps: { ...lighting.lamps, [id]: { ...lighting.lamps[id], ...patch } } });

  /** Structural edits of a light (rows, columns) are scene commands, so they are undoable. */
  const editLight = (id: string, patch: { rows?: number; cols?: number }) =>
    useSceneStore.getState().dispatch({ type: 'light.update', id, patch }, { coalesceKey: `light.update:${id}:${Object.keys(patch).join(',')}` });

  const now = () => {
    const local = instantToLocal(new Date(), scene.site.timezone);
    setLighting({ date: local.date, time: fromMinutes(Math.round(toMinutes(local.time) / STEP_MINUTES) * STEP_MINUTES) });
  };

  return (
    <section aria-label="Lighting" className="panel lighting" data-testid="lighting-panel">
      <h2>Lighting</h2>

      <fieldset>
        <legend>Sun</legend>
        <label className="check">
          <input type="checkbox" checked={lighting.sunEnabled} onChange={(e) => setLighting({ sunEnabled: e.target.checked })} />
          Sun and sky
        </label>
        <div className="field">
          <label htmlFor={ids.date}>Date</label>
          <input
            id={ids.date}
            type="date"
            data-testid="date-input"
            value={lighting.date}
            onChange={(e) => e.target.value && setLighting({ date: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.time}>Time of day</label>
          <input
            id={ids.time}
            type="range"
            data-testid="time-slider"
            min={min}
            max={max}
            step={STEP_MINUTES}
            value={current}
            aria-valuetext={lighting.time}
            onChange={(e) => setLighting({ time: fromMinutes(Number(e.target.value)) })}
          />
          <output htmlFor={ids.time} data-testid="time-output">
            {lighting.time}
          </output>
        </div>
        <div className="field">
          <label htmlFor={ids.clock}>Exact time</label>
          <input
            id={ids.clock}
            type="time"
            data-testid="time-input"
            step={STEP_MINUTES * 60}
            value={lighting.time}
            onChange={(e) => e.target.value && setLighting({ time: e.target.value })}
          />
        </div>
        <div className="row">
          <button type="button" onClick={now}>
            Now
          </button>
          <button type="button" aria-pressed={playing} data-testid="play-button" onClick={() => setPlaying(!playing)}>
            {playing ? 'Pause' : 'Play'}
          </button>
        </div>
        <div role="group" aria-label="Animation speed" className="row">
          {SPEEDS.map((s) => (
            <button key={s.label} type="button" aria-pressed={speed === s.minutesPerSecond} onClick={() => setSpeed(s.minutesPerSecond)}>
              {s.label}
            </button>
          ))}
        </div>
        <dl className="readout" data-testid="sun-readout" aria-live="off">
          {info.available ? (
            <>
              <div>
                <dt>Altitude</dt>
                <dd data-testid="sun-altitude">{info.altitudeDeg.toFixed(1)}°</dd>
              </div>
              <div>
                <dt>Azimuth</dt>
                <dd data-testid="sun-azimuth">{info.azimuthDeg.toFixed(1)}°</dd>
              </div>
              <div>
                <dt>Sunrise</dt>
                <dd>{info.sunrise ?? (info.polar === 'day' ? 'sun stays up' : 'no sunrise')}</dd>
              </div>
              <div>
                <dt>Sunset</dt>
                <dd>{info.sunset ?? (info.polar === 'night' ? 'sun stays down' : 'no sunset')}</dd>
              </div>
            </>
          ) : (
            <div>
              <dt>Sun</dt>
              <dd>unavailable</dd>
            </div>
          )}
        </dl>
      </fieldset>

      <div role="group" aria-label="Lighting presets" className="row">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" onClick={() => useViewStore.setState((s) => ({ lighting: applyPreset(s.lighting, p.id, scene.site, scene.lights) }))}>
            {p.label}
          </button>
        ))}
      </div>

      <fieldset>
        <legend>Exposure and surroundings</legend>
        <div className="field">
          <label htmlFor={ids.ev}>Exposure compensation (EV)</label>
          <input
            id={ids.ev}
            type="range"
            data-testid="ev-slider"
            min={-6}
            max={6}
            step={0.5}
            value={lighting.exposureEV}
            aria-valuetext={`${lighting.exposureEV > 0 ? '+' : ''}${lighting.exposureEV} EV`}
            onChange={(e) => setLighting({ exposureEV: Number(e.target.value) })}
          />
          <output htmlFor={ids.ev}>{`${lighting.exposureEV > 0 ? '+' : ''}${lighting.exposureEV}`}</output>
        </div>
        <label className="check">
          <input
            type="checkbox"
            data-testid="context-toggle"
            checked={lighting.showContext}
            disabled={!hasContext}
            onChange={(e) => setLighting({ showContext: e.target.checked })}
          />
          Show neighbouring buildings
        </label>
        <div className="field">
          <label htmlFor={ids.building}>Building</label>
          <select
            id={ids.building}
            data-testid="building-mode"
            value={buildingMode}
            disabled={!hasContext || !lighting.showContext}
            title="Orbit view: how the building around your flat is drawn. Ghost shows its shape without blocking the view; solid suits exterior views."
            onChange={(e) => setBuildingMode(e.target.value as BuildingMode)}
          >
            <option value="hidden">hidden</option>
            <option value="ghost">ghost</option>
            <option value="solid">solid</option>
          </select>
        </div>
        {!hasContext && <p className="hint">No site context for this flat.</p>}
      </fieldset>

      <fieldset>
        <legend>Lamps</legend>
        <label className="check">
          <input type="checkbox" data-testid="walk-lights-toggle" checked={walkLightsOn} onChange={(e) => setWalkLightsOn(e.target.checked)} />
          Lights on in walk mode
        </label>
        {walkOverride && (
          <p className="hint" data-testid="walk-lights-note">
            Walking: all lamps are on and exposure is +{WALK_LIGHTS_EV} EV. Your own settings return when you leave walk mode.
          </p>
        )}
        {scene.lights.length === 0 && <p className="hint">This flat has no lamps.</p>}
        <ul className="lamps">
          {scene.lights.map((light) => {
            const o = lighting.lamps[light.id] ?? {};
            const on = walkOverride || (o.on ?? light.on);
            const name = light.name ?? light.id;
            const total = o.lumens ?? lightLumens(light);
            const count = lightFixtureCount(light);
            return (
              <li key={light.id} data-testid={`lamp-${light.id}`}>
                <label className="check">
                  <input type="checkbox" checked={on} disabled={walkOverride} aria-label={`${name} on`} onChange={(e) => setLamp(light.id, { on: e.target.checked })} />
                  {name}
                </label>
                {light.type === 'grid' && (
                  <div className="lamp-fields" data-testid={`grid-${light.id}`}>
                    <NumberField label={`${name} rows`} value={light.rows} min={1} max={20} step={1} testId={`grid-rows-${light.id}`} onCommit={(rows) => editLight(light.id, { rows: Math.round(rows) })} />
                    <NumberField label={`${name} columns`} value={light.cols} min={1} max={20} step={1} testId={`grid-cols-${light.id}`} onCommit={(cols) => editLight(light.id, { cols: Math.round(cols) })} />
                  </div>
                )}
                <div className="lamp-fields">
                  {light.type === 'grid' ? (
                    <NumberField label={`${name} lumens each`} unit="lm" value={Math.round(total / count)} min={0} step={10} testId={`grid-each-${light.id}`} onCommit={(each) => setLamp(light.id, { lumens: each * count })} />
                  ) : (
                    <NumberField label={`${name} lumens`} unit="lm" value={total} min={0} step={50} onCommit={(lumens) => setLamp(light.id, { lumens })} />
                  )}
                  <NumberField label={`${name} kelvin`} unit="K" value={o.kelvin ?? light.kelvin} min={1000} max={12000} step={100} onCommit={(kelvin) => setLamp(light.id, { kelvin })} />
                </div>
                {light.type === 'grid' && (
                  <p className="hint" data-testid={`grid-total-${light.id}`}>
                    {light.rows * light.cols} fixtures, {Math.round(total)} lm in total
                  </p>
                )}
                {light.itemId !== undefined && <p className="hint" data-testid={`lamp-source-${light.id}`}>{sourceNote(light)}</p>}
              </li>
            );
          })}
        </ul>
      </fieldset>
    </section>
  );
}

function sourceNote(light: Light): string {
  switch (light.lumensSource) {
    case 'product':
      return 'Lamp item: lumens from the product page.';
    case 'estimated':
      return 'Lamp item: lumens estimated for this kind of lamp (the product page does not state them).';
    default:
      return 'Lamp item: lumens set by you.';
  }
}
