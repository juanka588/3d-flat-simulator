import { ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping } from 'three';
import type { ToneMapping } from 'three';

/**
 * Tone mapping of the display. `neutral` (Khronos PBR Neutral) keeps product and finish colours accurate, which matters
 * when the flat is a purchase plan, so it is the default and the one the exposure model (see lighting.ts) is calibrated
 * for. `agx` and `aces` are filmic options with a stronger highlight roll-off (and a desaturation of saturated colours);
 * pick one with `?tone=agx` or `?tone=aces`. Their exposure is scaled to give a comparable mid-grey.
 */
export type ToneName = 'neutral' | 'agx' | 'aces';

export interface ToneSetting {
  name: ToneName;
  mapping: ToneMapping;
  /** Multiplier of the auto exposure so that mid-grey lands where Neutral puts it. */
  exposureScale: number;
}

const SETTINGS: Record<ToneName, ToneSetting> = {
  neutral: { name: 'neutral', mapping: NeutralToneMapping, exposureScale: 1 },
  agx: { name: 'agx', mapping: AgXToneMapping, exposureScale: 1.15 },
  aces: { name: 'aces', mapping: ACESFilmicToneMapping, exposureScale: 0.85 },
};

export function toneSettingFor(name: string | null | undefined): ToneSetting {
  return SETTINGS[(name ?? 'neutral') as ToneName] ?? SETTINGS.neutral;
}

let cached: ToneSetting | null = null;

/** The tone mapping of this page load (`?tone=` in the URL; default `neutral`). */
export function toneMappingSetting(): ToneSetting {
  if (cached) return cached;
  cached = toneSettingFor(typeof location !== 'undefined' ? new URLSearchParams(location.search).get('tone') : null);
  return cached;
}
