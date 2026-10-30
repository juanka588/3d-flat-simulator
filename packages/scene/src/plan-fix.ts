import { applyCommand } from './commands/apply';
import { makeEnvelope } from './commands/parse';
import type { BatchCommand, LeafCommand } from './commands/schema';
import type { PlanFinding } from './plan-check';
import type { Scene } from './schema';
import { planCheck } from './validate';

export interface PlanFixPlan {
  /** One batch with every applied fix, in order; undefined when nothing could be applied. Applying it to the scene you passed gives `scene`. */
  command?: BatchCommand;
  /** Scene after the fixes. */
  scene: Scene;
  /** Ids of the findings whose fix was applied. */
  applied: string[];
  /** Requested ids that were not applied, with why. */
  skipped: { id: string; reason: string }[];
}

/** Most fixes one plan applies; the findings are re-checked after each one, so a loop can never run away. */
const MAX_FIXES = 100;

/**
 * Collects the fixes for `which` (`'safe'`: every finding whose fix is marked safe; or a list of finding ids) into one
 * undoable batch. A fix is computed against the scene as left by the previous ones (two edge snaps of one room, or a gap
 * and a joint on one wall, would otherwise overwrite each other), and a finding that a previous fix already resolved is
 * simply gone. Pure: nothing is applied to the scene you pass.
 */
export function planFixes(scene: Scene, which: 'safe' | readonly string[], label?: string): PlanFixPlan {
  const wanted = which === 'safe' ? undefined : new Set(which);
  const tried = new Set<string>();
  const skipped: PlanFixPlan['skipped'] = [];
  const commands: LeafCommand[] = [];
  const applied: string[] = [];
  let current = scene;
  for (let n = 0; n < MAX_FIXES; n++) {
    const next: PlanFinding | undefined = planCheck(current).find((f) => f.id !== undefined && !tried.has(f.id) && f.fix && (wanted ? wanted.has(f.id) : f.fix.safe));
    if (!next?.fix) break;
    tried.add(next.id!);
    const result = applyCommand(current, makeEnvelope(next.fix.command, { id: 'plan-fix', ts: 0, author: { kind: 'user' } }));
    if (!result.ok) {
      skipped.push({ id: next.id!, reason: result.errors[0]?.message ?? 'the fix was refused' });
      continue;
    }
    current = result.scene;
    commands.push(...next.fix.command.commands);
    applied.push(next.id!);
  }
  if (wanted) {
    const present = new Set(planCheck(scene).map((f) => f.id));
    for (const id of wanted) {
      if (!applied.includes(id) && !skipped.some((s) => s.id === id)) skipped.push({ id, reason: present.has(id) ? 'it has no fix' : 'no such finding (already fixed, or the plan changed)' });
    }
  }
  const text = label ?? (applied.length === 1 ? `Plan check: ${applied[0]}` : `Plan check: ${applied.length} fixes`);
  return {
    ...(commands.length ? { command: { type: 'batch', label: text.length > 200 ? `${text.slice(0, 199)}…` : text, commands } satisfies BatchCommand } : {}),
    scene: current,
    applied,
    skipped,
  };
}
