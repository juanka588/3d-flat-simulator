#!/usr/bin/env node
/* eslint-disable no-undef, no-empty, @typescript-eslint/no-unused-vars -- Node + browser-side script, not part of the app */
// Prints a markdown table from .tmp/perf/results/*.json (or the labels given as arguments).
import { readdirSync, readFileSync } from 'node:fs';

const dir = '.tmp/perf/results';
const want = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && (want.length === 0 || want.some((w) => f.includes(w))));
const rows = files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
const cols = [
  ['run', (r) => r.label],
  ['gpu', (r) => String(r.glRenderer).slice(0, 22)],
  ['1st draw ms', (r) => r.timing?.firstDrawMs],
  ['ready ms', (r) => r.sceneReady?.ms + (r.sceneLoad ? `+${r.sceneLoad.ms}` : '')],
  ['probes', (r) => `${r.afterLoad?.probes?.mode}${r.afterLoad?.probes?.lastBakeMs ? `/${r.afterLoad.probes.lastBakeMs}ms` : ''}`],
  ['heap MB', (r) => r.final?.heapMB],
  ['tex MB', (r) => r.final?.gl?.texMB],
  ['buf MB', (r) => r.final?.gl?.bufMB],
  ['calls', (r) => r.afterLoad?.renderer?.calls],
  ['tris', (r) => r.afterLoad?.renderer?.triangles],
  ['progs', (r) => r.afterLoad?.renderer?.programs],
  ['shader ms', (r) => r.final?.gl?.shaderMs],
  ['orbit p50/p95', (r) => `${r.orbit?.frameMs?.p50}/${r.orbit?.frameMs?.p95}`],
  ['orbit busy%', (r) => r.orbit?.mainThreadBusy],
  ['walk p50/p95', (r) => `${r.walk?.frameMs?.p50}/${r.walk?.frameMs?.p95}`],
  ['long tasks ms', (r) => r.final?.longTasks?.totalMs],
];
console.log(`| ${cols.map((c) => c[0]).join(' | ')} |`);
console.log(`|${cols.map(() => '---').join('|')}|`);
for (const r of rows) console.log(`| ${cols.map((c) => c[1](r) ?? '').join(' | ')} |`);
