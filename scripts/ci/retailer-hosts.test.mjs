/* global URL */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cfg = JSON.parse(readFileSync(new URL('./retailer-hosts.json', import.meta.url), 'utf8'));

describe('retailer-hosts.json (D4 deny-list)', () => {
  it('lists the spike retailers and affiliate / BIM hosts as bare lowercase hostnames', () => {
    for (const h of ['ikea.com', 'leroymerlin.fr', 'maisonsdumonde.com', 'castorama.fr', 'conforama.fr', 'but.fr', 'laredoute.fr', 'darty.com', 'awin1.com']) {
      expect(cfg.hosts).toContain(h);
    }
    for (const h of cfg.hosts) expect(h).toMatch(/^[a-z0-9]+([.-][a-z0-9]+)*\.[a-z]{2,}$/);
    expect(new Set(cfg.hosts).size).toBe(cfg.hosts.length);
  });

  it('denies stray models, env files and 3D-FUTURE, and has the allow lists the check needs', () => {
    expect(cfg.denyFiles).toEqual(expect.arrayContaining(['**/*.glb', '**/.env', '**/.env.*']));
    expect(cfg.denyFiles.some((p) => p.toLowerCase().includes('3d-future'))).toBe(true);
    expect(cfg.allowFiles).toContain('**/.env.example');
    expect(cfg.allowPaths).toContain('apps/server/src/providers/**');
    expect(cfg.version).toBe(1);
  });
});
