import { describe, expect, it } from 'vitest';
import type { ProviderInfo } from '@flat/scene';
import { DEV_OFFLINE_HINT, noResults, personalUseBanner, productsAvailability, providerView, SERVER_HINT, statusLine } from './panel-state';
import { armDecision } from './use-card-drag';
import { floorPoint, lineHeight } from './placement';

const info = (p: Partial<ProviderInfo>): ProviderInfo => ({ id: 'mock', label: 'Mock catalog', capabilities: { search: true, model3d: false, dims: 'structured', resolveUrl: true }, enabled: true, circuit: 'closed', personalUseOnly: false, ...p });

describe('panel state without a server', () => {
  it('the Products tab only offers the hint in Local / Pages mode, and needs a server url', () => {
    expect(productsAvailability({ mode: 'local', status: 'local', serverUrl: null })).toBe('no-server');
    expect(productsAvailability({ mode: 'server', status: 'connecting', serverUrl: null })).toBe('no-server');
    expect(productsAvailability({ mode: 'server', status: 'connected', serverUrl: 'http://127.0.0.1:8787' })).toBe('server');
    expect(SERVER_HINT).toContain('pnpm dev:all');
  });
});

describe('providers', () => {
  it('shows the personal-use banner only when an enabled provider is personal-use', () => {
    expect(personalUseBanner([info({})])).toBeNull();
    expect(personalUseBanner([info({ personalUseOnly: true, enabled: false })])).toBeNull();
    expect(personalUseBanner([info({}), info({ id: 'ikea-fr', personalUseOnly: true })])).toMatch(/^Personal use only/);
  });
  it('chips carry the circuit state and a tooltip', () => {
    expect(providerView(info({})).state).toBe('ok');
    const open = providerView(info({ circuit: 'open', retryAt: 130_000 }), 100_000);
    expect(open.state).toBe('paused');
    expect(open.tooltip).toContain('retries in 30 s');
    expect(providerView(info({ enabled: false })).state).toBe('off');
    expect(providerView(info({ circuit: 'half_open' })).state).toBe('checking');
  });
});

describe('card drag arming', () => {
  it('a mouse drags after 5 px', () => {
    expect(armDecision('mouse', 2, 10)).toBe('wait');
    expect(armDecision('mouse', 6, 10)).toBe('drag');
  });
  it('a touch needs a 350 ms hold; moving earlier scrolls', () => {
    expect(armDecision('touch', 0, 100)).toBe('wait');
    expect(armDecision('touch', 0, 360)).toBe('drag');
    expect(armDecision('touch', 20, 100)).toBe('cancel');
  });
});

describe('pointer rays', () => {
  it('hits the floor and misses upward rays', () => {
    expect(floorPoint({ origin: [0, 10, 0], dir: [0, -1, 0] })).toEqual([0, 0]);
    expect(floorPoint({ origin: [1, 2, 3], dir: [1, -1, 0] })).toEqual([3, 3]);
    expect(floorPoint({ origin: [0, 1, 0], dir: [0, 1, 0] })).toBeNull();
  });
  it('reads a height on the vertical line through a point', () => {
    expect(lineHeight({ origin: [0, 1.2, 5], dir: [0, 0, -1] }, 0, 0)).toBeCloseTo(1.2, 9);
    expect(lineHeight({ origin: [3, 4, 0], dir: [0, -1, 0] }, 0, 0)).toBeNull();
  });
});

describe('empty search explanations', () => {
  it('names the query and each provider status', () => {
    const r = noResults(' lit ', [{ provider: 'ikea-fr', ok: false, code: 'blocked', message: 'HTTP 403' }, { provider: 'mock', ok: true }]);
    expect(r.title).toBe('No results for "lit"');
    expect(r.details).toEqual(['ikea-fr: HTTP 403', 'mock: no match']);
  });
  it('adds circuit open and the retry delay', () => {
    const line = statusLine({ provider: 'ikea-fr', ok: false, code: 'circuit_open' }, [info({ id: 'ikea-fr', circuit: 'open', retryAt: 130_000 })], 100_000);
    expect(line).toBe('ikea-fr: circuit_open, circuit open, retry in 30 s');
  });
  it('the offline hint explains how to start the server', () => {
    expect(DEV_OFFLINE_HINT).toContain('dev:all');
    expect(DEV_OFFLINE_HINT).toContain('FLAT_PROVIDERS=ikea-fr');
  });
});
