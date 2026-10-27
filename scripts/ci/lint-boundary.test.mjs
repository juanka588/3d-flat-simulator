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
