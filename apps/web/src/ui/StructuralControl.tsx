import { structuralInfo } from '@flat/scene';
import type { Scene, StructuralSource } from '@flat/scene';
import { useSceneStore } from '../state/sceneStore';

const SOURCE_TEXT: Record<StructuralSource, string> = {
  explicit: 'set manually',
  exterior: 'default: exterior wall',
  thickness: 'default: 15 cm or thicker',
  partition: 'default: thin interior wall',
};

/** Badge, source and toggle for a wall's structural status (M3.15). Changes are undoable. */
export function StructuralControl({ scene, wallId }: { scene: Scene; wallId: string }) {
  const dispatch = useSceneStore((s) => s.dispatch);
  const wall = scene.walls.find((w) => w.id === wallId);
  if (!wall) return null;
  const info = structuralInfo(scene, wall);
  const set = (structural: boolean | null) => {
    dispatch({ type: 'wall.setStructural', wallId, structural });
  };
  return (
    <div className="structural-control" data-testid="structural-control">
      <p className={`structural-badge ${info.structural ? 'structural' : 'removable'}`} data-testid="structural-badge">
        <strong>{info.structural ? 'Structural (load-bearing/façade)' : 'Removable partition'}</strong>
        <span className="structural-source"> {SOURCE_TEXT[info.source]}</span>
      </p>
      <div className="structural-actions">
        <button
          type="button"
          aria-pressed={info.structural}
          onClick={() => set(!info.structural)}
        >
          Structural wall
        </button>
        {info.source === 'explicit' && (
          <button type="button" onClick={() => set(null)}>
            Use automatic
          </button>
        )}
      </div>
    </div>
  );
}
