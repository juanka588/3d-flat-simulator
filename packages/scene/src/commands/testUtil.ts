import charme from '../../fixtures/charme-3205.flat.json';
import sample from '../../fixtures/sample.flat.json';
import { parseScene } from '../parse';
import type { Scene } from '../schema';
import { makeEnvelope } from './parse';
import type { Command, CommandEnvelope } from './schema';

function load(data: unknown): Scene {
  const r = parseScene(data);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}

export const FIXTURES: Record<string, Scene> = { charme: load(charme), sample: load(sample) };

let counter = 0;
export function env(cmd: Command, extra: Partial<CommandEnvelope> = {}): CommandEnvelope {
  counter++;
  return { ...makeEnvelope(cmd, { id: `e${counter}`, ts: 1000 + counter }), ...extra };
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
