import { describe, expect, it } from 'vitest';
import { meshBadge } from './ItemProperties';

describe('meshBadge', () => {
  it('a settled placeholder says it is a plain box and why', () => {
    const b = meshBadge('placeholder', false, undefined, { loading: false, reason: 'no model could be loaded' });
    expect(b.kind).toBe('placeholder');
    expect(b.title).toContain('no model could be loaded');
  });
  it('a placeholder that is still loading stays "loading"', () => {
    expect(meshBadge('placeholder', false, undefined, { loading: true }).kind).toBe('loading');
    expect(meshBadge('placeholder', false).kind).toBe('loading');
  });
  it('offline items that got a stand-in keep the offline badge, with the reason', () => {
    const b = meshBadge('lookalike', true, undefined, { loading: false, reason: 'best library lookalike' });
    expect(b.kind).toBe('offline');
    expect(b.title).toContain('best library lookalike');
  });
});
