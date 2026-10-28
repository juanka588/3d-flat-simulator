import { describe, expect, it } from 'vitest';
import { facadeSymbols, rewriteSource } from './rewrite-imports.mjs';

const SYMS = ['resolveMesh', 'ProductRecord', 'MeshCatalog'];
const rw = (s) => rewriteSource(s, SYMS);

describe('facadeSymbols', () => {
  it('reads the explicit list of the assets facade', () => {
    const s = facadeSymbols();
    expect(s).toContain('resolveMesh');
    expect(s).toContain('ProductRecord');
    expect(s).toContain('MeshCatalog');
    expect(s).not.toContain('Scene');
  });
});

describe('rewriteSource', () => {
  it('retargets a declaration whose specifiers all move', () => {
    expect(rw("import { resolveMesh, ProductRecord } from '@flat/scene';\n").text).toBe("import { resolveMesh, ProductRecord } from '@flat/assets';\n");
  });
  it('splits a mixed declaration and keeps type-only and aliases', () => {
    const r = rw("import type { Scene, ProductRecord as PR } from '@flat/scene';\n");
    expect(r.text).toBe("import type { Scene } from '@flat/scene';\nimport type { ProductRecord as PR } from '@flat/assets';\n");
    expect(r.moved).toBe(1);
  });
  it('handles inline type specifiers and re-exports', () => {
    expect(rw("import { Scene, type MeshCatalog } from '@flat/scene';").text).toBe("import { Scene } from '@flat/scene';\nimport { type MeshCatalog } from '@flat/assets';");
    expect(rw('export { resolveMesh } from "@flat/scene";').text).toBe('export { resolveMesh } from "@flat/assets";');
  });
  it('leaves other modules, namespaces and untouched files alone', () => {
    for (const s of ["import * as s from '@flat/scene';", "import { Scene } from '@flat/scene';", "import { resolveMesh } from './x';", "import f from '@flat/scene/fixtures/a.json';"]) {
      expect(rw(s)).toEqual({ text: s, moved: 0 });
    }
  });
  it('keeps a multi-line declaration multi-line', () => {
    const r = rw("import {\n  Scene,\n  Item,\n  resolveMesh,\n  ProductRecord,\n  MeshCatalog,\n} from '@flat/scene';\n");
    expect(r.text).toBe("import { Scene, Item } from '@flat/scene';\nimport {\n  resolveMesh,\n  ProductRecord,\n  MeshCatalog,\n} from '@flat/assets';\n");
  });
});
