import { PLAN_CODES, planCheck, planFixes } from '@flat/scene';
import type { PlanFinding, Scene, ValidationWarning } from '@flat/scene';
import { useState } from 'react';
import { useSceneStore } from '../state/sceneStore';
import { useViewStore } from '../state/viewStore';

/** `planCheck` is a few milliseconds, but the list, the badge and the buttons all want it for one scene object. */
const cache = new WeakMap<Scene, PlanFinding[]>();
export function planFindings(scene: Scene): PlanFinding[] {
  let found = cache.get(scene);
  if (!found) {
    found = planCheck(scene);
    cache.set(scene, found);
  }
  return found;
}

/** Small badge for the sidebar header: the number of plan warnings, hidden when there are none. */
export function PlanBadge({ scene }: { scene: Scene }) {
  const count = planFindings(scene).filter((f) => f.severity === 'warning').length;
  if (count === 0) return null;
  return (
    <a className="plan-badge" href="#warnings" data-testid="plan-badge" title={`Plan check: ${count} warning${count === 1 ? '' : 's'}`} aria-label={`Plan check: ${count} warning${count === 1 ? '' : 's'}`}>
      ⚠ {count}
    </a>
  );
}

/**
 * Warnings of the flat. The plan-coherence ones (wall gaps, rooms off their walls, recesses in the wrong room, ...)
 * are computed from the scene as it is now and carry a proposed fix; "Apply fix" runs it as one undoable batch,
 * "Apply all safe fixes" runs every small unambiguous snap together. Hovering or focusing a row flags its walls and
 * rooms in red in the view. Joints without overlap are listed apart, as advisories.
 */
export function WarningsList({
  scene,
  warnings,
  onSelect,
}: {
  scene: Scene;
  warnings: ValidationWarning[];
  onSelect: (entityId: string) => void;
}) {
  const dispatch = useSceneStore((s) => s.dispatch);
  const setHighlight = useViewStore((s) => s.setHighlight);
  const [problem, setProblem] = useState<string | null>(null);
  const findings = planFindings(scene);
  const live = findings.filter((f) => f.severity === 'warning');
  const advisories = findings.filter((f) => f.severity === 'advisory');
  const others = warnings.filter((w) => !PLAN_CODES.has(w.code));
  const rows: ValidationWarning[] = [...live, ...others];
  const safe = findings.filter((f) => f.fix?.safe);
  if (rows.length === 0 && advisories.length === 0) return null;

  const run = (command: Parameters<typeof dispatch>[0]) => {
    const result = dispatch(command);
    setHighlight([]);
    setProblem(result.ok ? null : (result.errors[0]?.message ?? 'the fix was refused'));
  };
  const applyAllSafe = () => {
    const plan = planFixes(scene, 'safe');
    if (plan.command) run(plan.command);
  };

  const row = (w: ValidationWarning, i: number) => {
    const target = w.entityIds[0];
    return (
      <li
        key={w.id ?? i}
        data-code={w.code}
        data-id={w.id}
        onMouseEnter={() => setHighlight(w.entityIds)}
        onMouseLeave={() => setHighlight([])}
        onFocus={() => setHighlight(w.entityIds)}
        onBlur={() => setHighlight([])}
      >
        {target ? (
          <button type="button" className="link" onClick={() => onSelect(target)}>
            {w.message}
          </button>
        ) : (
          w.message
        )}
        {w.fix && (
          <div className="plan-fix">
            <span className="plan-fix-label">Fix: {w.fix.label}</span>
            <button type="button" data-testid="plan-fix" title={w.fix.safe ? 'A small snap' : 'Check the plan after applying: not marked safe'} onClick={() => run(w.fix!.command)}>
              Apply fix
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <section aria-label="Warnings" id="warnings" className="panel" data-testid="warnings">
      <h2>Warnings ({rows.length})</h2>
      {safe.length > 0 && (
        <button type="button" className="plan-fix-all" data-testid="plan-fix-all" onClick={applyAllSafe}>
          Apply all safe fixes ({safe.length})
        </button>
      )}
      {problem && (
        <p className="hint" role="alert" data-testid="plan-fix-error">
          {problem}
        </p>
      )}
      <ul>{rows.map(row)}</ul>
      {advisories.length > 0 && (
        <details data-testid="plan-advisories">
          <summary>Joints without overlap ({advisories.length}): light can leak</summary>
          <ul>{advisories.map(row)}</ul>
        </details>
      )}
    </section>
  );
}
