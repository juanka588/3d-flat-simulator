import { ESLint } from 'eslint';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: root });

async function lint(file, code) {
  const [r] = await eslint.lintText(code, { filePath: resolve(root, file) });
  return r.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

describe('local-only import boundary (D4)', () => {
  const bad = [
    "import x from '../../server/src/providers/ikea-fr';",
    "import x from '../../../apps/server/src/app';",
    "import x from '@flat/server';",
    "import x from './providers/mock';",
  ];
  for (const file of ['apps/web/src/catalog/x.ts', 'apps/web/src/ui/X.tsx', 'packages/scene/src/x.ts']) {
    it(`${file} may not import the server or provider code`, async () => {
      for (const code of bad) expect(await lint(file, `${code}\nexport { x };\n`), code).not.toEqual([]);
    });
  }
  it('the scene package still may not import react or three', async () => {
    expect(await lint('packages/scene/src/x.ts', "import 'react';\nimport 'three';\n")).toHaveLength(2);
  });
  it('the server and the MCP app may use their own code', async () => {
    expect(await lint('apps/server/src/x.ts', "import x from './providers/mock';\nexport { x };\n")).toEqual([]);
  });
});

// ---- Per-package boundaries (docs/architecture/modules.md sections 2.1 and 2.2). Most of these packages do not exist yet:
// ESLint resolves the config by virtual file path, so the rules are testable before the migration creates them.
describe('server/provider ban covers every package', () => {
  const bad = ["import x from '@flat/server';", "import x from './providers/mock';"];
  for (const file of [
    'packages/assets/src/x.ts',
    'packages/assets/src/node/x.ts',
    'packages/site/src/x.ts',
    'packages/site/src/node/x.ts',
    'packages/viewer/src/X.tsx',
    'packages/viewer/src/element/x.ts',
    'packages/capture/src/x.ts',
    'packages/scene/src/live/x.ts',
  ]) {
    it(`${file} may not import the server or provider code`, async () => {
      for (const code of bad) expect(await lint(file, `${code}\nexport { x };\n`), `${file}: ${code}`).not.toEqual([]);
    });
  }
});

describe('package graph boundaries', () => {
  const blocked = async (file, code) => expect(await lint(file, `${code}\n`), `${file}: ${code}`).not.toEqual([]);
  const allowed = async (file, code) => expect(await lint(file, `${code}\n`), `${file}: ${code}`).toEqual([]);

  it('scene is the root: it imports no other package, by name or by relative path', async () => {
    for (const code of [
      "import x from '@flat/assets';",
      "import x from '@flat/assets/node';",
      "import x from '@flat/site';",
      "import x from '@flat/viewer';",
      "import x from '@flat/capture';",
      "import x from '../../assets/src/x';",
    ]) {
      await blocked('packages/scene/src/x.ts', code);
    }
    await allowed('packages/scene/src/x.ts', "import { z } from 'zod';\nimport x from './schema';\nexport { x, z };");
    await allowed('packages/scene/src/x.test.ts', "import { readFileSync } from 'node:fs';\nexport { readFileSync };");
    await blocked('packages/scene/src/x.ts', "import { readFileSync } from 'node:fs';\nexport { readFileSync };");
    await blocked('packages/scene/src/x.ts', "import 'zustand';");
  });

  it('the temporary scene generators setup may reach assets, but still not the renderer', async () => {
    await allowed('packages/scene/test/generators.setup.ts', "import '../../assets/src/register';");
    await blocked('packages/scene/test/generators.setup.ts', "import 'three';");
  });

  it('@flat/scene/live stays pure', async () => {
    await blocked('packages/scene/src/live/x.ts', "import 'three';");
    await blocked('packages/scene/src/live/x.ts', "import 'node:fs';");
    await blocked('packages/scene/src/live/x.ts', "import '@flat/assets';");
    await allowed('packages/scene/src/live/x.ts', "import { z } from 'zod';\nimport x from '../schema';\nexport { x, z };");
  });

  it('assets: the universal entry has no node built-ins, the node entry may; neither reaches site, viewer or capture', async () => {
    await blocked('packages/assets/src/x.ts', "import 'node:fs';");
    await blocked('packages/assets/src/x.ts', "import 'three';");
    await blocked('packages/assets/src/x.ts', "import '@flat/site';");
    await blocked('packages/assets/src/x.ts', "import '@flat/viewer';");
    await blocked('packages/assets/src/x.ts', "import '@flat/assets/node';");
    await blocked('packages/assets/src/x.ts', "import x from '../../scene/src/schema';");
    await allowed('packages/assets/src/x.ts', "import x from '@flat/scene';\nexport { x };");
    await allowed('packages/assets/src/node/x.ts', "import { readFileSync } from 'node:fs';\nimport x from '@flat/scene';\nimport y from '@flat/assets';\nexport { readFileSync, x, y };");
    await blocked('packages/assets/src/node/x.ts', "import '@flat/site';");
    await blocked('packages/assets/src/node/x.ts', "import 'react';");
  });

  it('site: scene only; node built-ins and site/node only from src/node', async () => {
    await blocked('packages/site/src/x.ts', "import 'node:fs';");
    await blocked('packages/site/src/x.ts', "import '@flat/assets';");
    await blocked('packages/site/src/x.ts', "import '@flat/site/node';");
    await allowed('packages/site/src/x.ts', "import x from '@flat/scene';\nexport { x };");
    await allowed('packages/site/src/node/x.ts', "import { readFileSync } from 'node:fs';\nimport y from '@flat/site';\nexport { readFileSync, y };");
    await blocked('packages/site/src/node/x.ts', "import '@flat/assets';");
  });

  it('capture: scene and site only, no renderer, no node', async () => {
    await allowed('packages/capture/src/x.ts', "import x from '@flat/scene';\nimport y from '@flat/site';\nexport { x, y };");
    await blocked('packages/capture/src/x.ts', "import '@flat/assets';");
    await blocked('packages/capture/src/x.ts', "import '@flat/viewer';");
    await blocked('packages/capture/src/x.ts', "import '@flat/site/node';");
    await blocked('packages/capture/src/x.ts', "import 'react';");
    await blocked('packages/capture/src/x.ts', "import 'node:fs';");
  });

  it('viewer: scene and assets, no editor/app code, no site, capture or node entries', async () => {
    await blocked('packages/viewer/src/X.tsx', "import x from '../../../apps/web/src/state/sceneStore';");
    await blocked('packages/viewer/src/X.tsx', "import x from '@flat/site';");
    await blocked('packages/viewer/src/X.tsx', "import x from '@flat/assets/node';");
    await blocked('packages/viewer/src/X.tsx', "import x from '@flat/capture';");
    await blocked('packages/viewer/src/X.tsx', "import 'node:fs';");
    await allowed(
      'packages/viewer/src/X.tsx',
      "import React from 'react';\nimport * as THREE from 'three';\nimport s from '@flat/scene';\nimport a from '@flat/assets';\nimport l from '@flat/scene/live';\nexport { React, THREE, s, a, l };",
    );
  });

  it('@flat/viewer/element depends on the viewer alone', async () => {
    await blocked('packages/viewer/src/element/x.ts', "import '@flat/scene';");
    await blocked('packages/viewer/src/element/x.ts', "import '@flat/assets';");
    await allowed('packages/viewer/src/element/x.ts', "import x from '../FlatCanvas';\nimport r from 'react-dom/client';\nexport { x, r };");
  });

  it('apps/web: no viewer/testing outside testHook*.ts, no node entries, no server', async () => {
    await blocked('apps/web/src/ui/X.tsx', "import x from '@flat/viewer/testing';");
    await blocked('apps/web/src/ui/X.tsx', "import x from '@flat/viewer/internal/model-cache';");
    await blocked('apps/web/src/ui/X.tsx', "import x from '@flat/assets/node';");
    await blocked('apps/web/src/ui/X.tsx', "import x from '@flat/site/node';");
    await blocked('apps/web/src/ui/X.tsx', "import x from '../../../../packages/scene/src/schema';");
    await allowed(
      'apps/web/src/ui/X.tsx',
      "import v from '@flat/viewer';\nimport a from '@flat/assets';\nimport s from '@flat/site';\nimport c from '@flat/capture';\nimport sc from '@flat/scene';\nexport { v, a, s, c, sc };",
    );
    await allowed('apps/web/src/testHook.ts', "import t from '@flat/viewer/testing';\nexport { t };");
    await allowed('apps/web/src/testHookStats.ts', "import t from '@flat/viewer/testing';\nexport { t };");
    await blocked('apps/web/src/testHook.ts', "import x from '@flat/assets/node';");
    await blocked('apps/web/src/testHook.ts', "import x from '@flat/server';");
    await blocked('apps/web/src/state/s.ts', "import 'node:fs';");
  });

  it('apps/web/src/viewer shims (temporary) may re-export @flat/viewer/internal, nothing else may', async () => {
    await allowed('apps/web/src/viewer/FlatCanvas.ts', "export * from '@flat/viewer/internal/FlatCanvas';");
    await blocked('apps/web/src/viewer/FlatCanvas.ts', "export * from '@flat/viewer/testing';");
  });

  it('no package imports an app', async () => {
    await blocked('packages/assets/src/x.ts', "import x from '@flat/web';");
    await blocked('packages/viewer/src/X.tsx', "import x from '@flat/mcp';");
    await blocked('apps/server/src/x.ts', "import x from '@flat/web';");
  });

  it('apps/server: node, scene, assets and site are fine; no viewer and no renderer', async () => {
    await allowed('apps/server/src/x.ts', "import 'node:fs';\nimport a from '@flat/assets/node';\nimport s from '@flat/site/node';\nimport c from '@flat/capture';\nexport { a, s, c };");
    await blocked('apps/server/src/x.ts', "import x from '@flat/viewer';");
    await blocked('apps/server/src/x.ts', "import 'three';");
    await blocked('apps/server/src/x.ts', "import x from '../../web/src/x';");
  });

  it('apps/mcp: the server only from src/testing/**, no viewer, no renderer, no assets/node', async () => {
    await allowed('apps/mcp/src/testing/harness.ts', "import x from '@flat/server/src/server';\nexport { x };");
    await blocked('apps/mcp/src/tools/x.ts', "import x from '@flat/server';");
    await blocked('apps/mcp/src/render/x.test.ts', "import x from '@flat/server/src/server';");
    await blocked('apps/mcp/src/x.ts', "import x from '@flat/viewer';");
    await blocked('apps/mcp/src/x.ts', "import x from '@flat/assets/node';");
    await blocked('apps/mcp/src/x.ts', "import x from '@flat/capture';");
    await blocked('apps/mcp/src/x.ts', "import 'react';");
    await allowed('apps/mcp/src/x.ts', "import 'node:fs';\nimport s from '@flat/scene';\nimport a from '@flat/assets';\nimport t from '@flat/site/node';\nexport { s, a, t };");
  });

  it('MCP stdout stays clean: no console.log in apps/mcp/src', async () => {
    const [r] = await eslint.lintText('console.log(1);\n', { filePath: resolve(root, 'apps/mcp/src/x.ts') });
    expect(r.messages.some((m) => m.ruleId === 'no-console')).toBe(true);
  });
});
