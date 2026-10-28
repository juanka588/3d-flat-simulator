/* global console, process */
// Import codemod for the module split (docs/architecture/modules.md step A3): moves the asset and product-wire symbols
// that a file imports (or re-exports) from '@flat/scene' to '@flat/assets'. The symbol list is NOT written down here: it
// is the explicit named export list of packages/assets/src/index.ts (the future public API), read with the TypeScript
// parser. Reused by A3a (apps/web) and by eslint.config.js (the `importNames` rule).
//
//   node scripts/refactor/rewrite-imports.mjs [--check] [--relative] [--from @flat/scene] [--to @flat/assets] <dir-or-file>...
//   --relative: for e2e/ and scripts/, which import scene by relative path into packages/scene/src; the moved symbols
//   are retargeted to the facade packages/assets/src/index by relative path.
//
// Without --check the files are rewritten in place. With --check nothing is written and the exit code is 1 when a file
// would change. Only `import {..} from` and `export {..} from` are rewritten; namespace/default imports are left alone.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FACADE_INDEX = join(ROOT, 'packages/assets/src/index.ts');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.tmp', '.claude', 'test-results', 'playwright-report', 'coverage']);

/** The exported names of a facade index (`export { a, b as c } from '...'`, `export type {...}`): the exported (outer) names. */
export function facadeSymbols(indexPath = FACADE_INDEX) {
  const sf = ts.createSourceFile(indexPath, readFileSync(indexPath, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set();
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    for (const el of st.exportClause.elements) names.add(el.name.text);
  }
  return [...names].sort();
}

const quoteOf = (text, node) => text[node.moduleSpecifier.getStart()];

/**
 * Rewrites one file's text. Returns `{ text, moved }` (the number of specifiers moved). A declaration whose specifiers all
 * move is retargeted in place; a mixed one is split in two, the moved part inserted right after it.
 */
export function rewriteSource(text, symbols, { from = '@flat/scene', to = '@flat/assets', fileName = 'x.ts', relative: rel = false } = {}) {
  if (!rel && !text.includes(from)) return { text, moved: 0 };
  // `rel`: the file (e2e, scripts) reaches scene by a relative path into packages/scene/src; match those specifiers and
  // retarget them to the facade by relative path too (these roots are not packages and cannot resolve '@flat/*').
  const sceneSrc = join(ROOT, 'packages/scene/src');
  const isFrom = (spec) => (rel ? spec.startsWith('.') && resolve(dirname(fileName), spec).startsWith(sceneSrc) : spec === from);
  const toFor = (spec) => {
    if (!rel) return to;
    const r = relative(dirname(fileName), FACADE_INDEX).replace(/\.ts$/, spec.endsWith('.ts') ? '.ts' : '');
    return r.startsWith('.') ? r : `./${r}`;
  };
  const set = new Set(symbols);
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [];
  let moved = 0;
  for (const st of sf.statements) {
    const isImport = ts.isImportDeclaration(st);
    const isExport = ts.isExportDeclaration(st);
    if (!(isImport || isExport) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || !isFrom(st.moduleSpecifier.text)) continue;
    const named = isImport ? (st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings) ? st.importClause.namedBindings : undefined) : st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause : undefined;
    if (!named) continue;
    // `import D, { a }` (default + named) is not used for scene; skip rather than guess.
    if (isImport && st.importClause?.name) continue;
    const typeOnly = isImport ? !!st.importClause?.isTypeOnly : st.isTypeOnly;
    const els = named.elements;
    const move = els.filter((e) => set.has((e.propertyName ?? e.name).text));
    if (move.length === 0) continue;
    moved += move.length;
    const q = quoteOf(text, st);
    const fromSpec = st.moduleSpecifier.text;
    const spec = (e) => e.getText(sf);
    const build = (list) => {
      const body = `{ ${list.map(spec).join(', ')} }`;
      const kw = isImport ? 'import' : 'export';
      return `${kw} ${typeOnly ? 'type ' : ''}${body} from ${q}%MOD%${q};`;
    };
    const keep = els.filter((e) => !move.includes(e));
    const multiline = text.slice(st.getStart(), st.getEnd()).includes('\n');
    const render = (list, mod) => {
      const one = build(list).replace('%MOD%', mod);
      if (!multiline || list.length < 3) return one;
      const kw = isImport ? 'import' : 'export';
      return `${kw} ${typeOnly ? 'type ' : ''}{\n${list.map((e) => `  ${spec(e)},`).join('\n')}\n} from ${q}${mod}${q};`;
    };
    if (keep.length === 0) {
      edits.push({ start: st.getStart(), end: st.getEnd(), text: render(move, toFor(fromSpec)) });
    } else {
      edits.push({ start: st.getStart(), end: st.getEnd(), text: `${render(keep, fromSpec)}\n${render(move, toFor(fromSpec))}` });
    }
  }
  if (edits.length === 0) return { text, moved: 0 };
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, moved };
}

function* walk(p) {
  const st = statSync(p);
  if (st.isFile()) {
    if (/\.(ts|tsx|mts|mjs)$/.test(p) && !p.endsWith('.d.ts')) yield p;
    return;
  }
  for (const name of readdirSync(p)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(join(p, name));
  }
}

export function rewriteTree(paths, symbols, opts = {}) {
  const changed = [];
  for (const p of paths) {
    for (const file of walk(resolve(p))) {
      const src = readFileSync(file, 'utf8');
      const r = rewriteSource(src, symbols, { ...opts, fileName: file });
      if (r.moved === 0) continue;
      changed.push({ file, moved: r.moved });
      if (!opts.check) writeFileSync(file, r.text);
    }
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = { check: false, from: '@flat/scene', to: '@flat/assets', relative: false };
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') opts.check = true;
    else if (args[i] === '--relative') opts.relative = true;
    else if (args[i] === '--from') opts.from = args[++i];
    else if (args[i] === '--to') opts.to = args[++i];
    else paths.push(args[i]);
  }
  if (paths.length === 0) {
    console.error('usage: rewrite-imports.mjs [--check] [--from pkg] [--to pkg] <dir-or-file>...');
    process.exit(2);
  }
  const symbols = facadeSymbols();
  const changed = rewriteTree(paths, symbols, opts);
  for (const c of changed) console.log(`${opts.check ? 'would rewrite' : 'rewrote'} ${c.file.replace(`${ROOT}/`, '')} (${c.moved})`);
  console.log(`${changed.length} file(s), ${changed.reduce((n, c) => n + c.moved, 0)} specifier(s) ${opts.check ? 'to move' : 'moved'}`);
  if (opts.check && changed.length) process.exit(1);
}
