import { useId } from 'react';
import { applyPreset } from '@flat/scene';
import type { LampOverride, PresetName, Scene } from '@flat/scene';
import { SPEEDS, useClockStore } from '../state/dayClock';
import { fromMinutes, instantToLocal, toMinutes } from '../state/localTime';
import { sunInfoFor } from '../state/sunInfo';
import { useViewStore } from '../state/viewStore';
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
  const { playing, speed, setPlaying, setSpeed } = useClockStore();
  const ids = { date: useId(), time: useId(), clock: useId(), ev: useId() };
  const info = sunInfoFor(scene, lighting);

  const current = toMinutes(lighting.time);
  // Slider spans the daylight range; it widens (never narrows) to keep the current time reachable.
  const lo = info.available ? Math.floor(toMinutes(info.rangeStart) / STEP_MINUTES) * STEP_MINUTES : 0;
  const hi = info.available ? Math.ceil(toMinutes(info.rangeEnd) / STEP_MINUTES) * STEP_MINUTES : 1439;
  const min = Math.min(lo, Math.floor(current / STEP_MINUTES) * STEP_MINUTES);
  const max = Math.max(hi, Math.ceil(current / STEP_MINUTES) * STEP_MINUTES);

  const setLamp = (id: string, patch: LampOverride) =>
    setLighting({ lamps: { ...lighting.lamps, [id]: { ...lighting.lamps[id], ...patch } } });

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
        {!hasContext && <p className="hint">No site context for this flat.</p>}
      </fieldset>

      <fieldset>
        <legend>Lamps</legend>
        {scene.lights.length === 0 && <p className="hint">This flat has no lamps.</p>}
        <ul className="lamps">
          {scene.lights.map((light) => {
            const o = lighting.lamps[light.id] ?? {};
            const on = o.on ?? light.on;
            const name = light.name ?? light.id;
            return (
              <li key={light.id} data-testid={`lamp-${light.id}`}>
                <label className="check">
                  <input type="checkbox" checked={on} aria-label={`${name} on`} onChange={(e) => setLamp(light.id, { on: e.target.checked })} />
                  {name}
                </label>
                <div className="lamp-fields">
                  <NumberField label={`${name} lumens`} unit="lm" value={o.lumens ?? light.lumens} min={0} step={50} onCommit={(lumens) => setLamp(light.id, { lumens })} />
                  <NumberField label={`${name} kelvin`} unit="K" value={o.kelvin ?? light.kelvin} min={1000} max={12000} step={100} onCommit={(kelvin) => setLamp(light.id, { kelvin })} />
                </div>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </section>
  );
}
