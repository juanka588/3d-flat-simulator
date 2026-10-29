import { useSceneStore } from '../state/sceneStore';
import { useViewerHealth } from '@flat/viewer';
import { downloadFlat } from './export-file';

const PART: Record<string, string> = {
  shell: 'the flat',
  lighting: 'the lighting',
  camera: 'the camera',
  webgl: 'the graphics context',
  app: 'the page',
};

/** Shown when part of the 3D view failed to draw: says what, what is still on screen, and how to save the work. */
export function ViewerErrorBanner() {
  const problem = useViewerHealth((s) => s.problem);
  const name = useSceneStore((s) => s.scene?.name ?? '');
  if (!problem) return null;
  const details = `${problem.source}: ${problem.message}`;
  return (
    <div className="viewer-error-banner" role="alert" data-testid="viewer-error">
      <div>
        <strong>The 3D view could not draw {PART[problem.source] ?? 'part of the scene'}.</strong> {problem.message}{' '}
        {problem.keptLastGood ? 'Showing the last version that drew correctly.' : 'Nothing could be shown.'} Your flat is safe: export it, then reload the page.
      </div>
      <div className="buttons">
        <button type="button" className="link" data-testid="viewer-error-export" onClick={() => downloadFlat(name)}>
          Export .flat.json
        </button>
        <button type="button" className="link" onClick={() => void navigator.clipboard?.writeText(details)}>
          Copy details
        </button>
        <button type="button" className="link" onClick={() => useViewerHealth.getState().clear()}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
