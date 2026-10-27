import { eyeHeightM, MAX_PERSON_HEIGHT_CM, MIN_PERSON_HEIGHT_CM } from '../viewer/walk-camera';
import { useViewStore } from '../state/viewStore';
import { useSyncStore } from '../sync/sync-store';
import { NumberField } from './NumberField';

/** View preferences (not part of the Scene): kept in localStorage. */
export function ViewSettings() {
  const personHeightCm = useViewStore((s) => s.personHeightCm);
  const setPersonHeightCm = useViewStore((s) => s.setPersonHeightCm);
  const serverMode = useSyncStore((s) => s.mode === 'server');
  const follow = useViewStore((s) => s.followAssistant);
  const setFollow = useViewStore((s) => s.setFollowAssistant);
  return (
    <section aria-label="Walk view" className="panel">
      <NumberField
        label="Person height"
        unit="cm"
        testId="person-height"
        value={personHeightCm}
        min={MIN_PERSON_HEIGHT_CM}
        max={MAX_PERSON_HEIGHT_CM}
        step={1}
        onCommit={setPersonHeightCm}
      />
      <p className="hint" data-testid="eye-height">
        Eye height in walk mode: {eyeHeightM(personHeightCm).toFixed(2)} m
      </p>
      {serverMode && (
        <label className="check" title="Show the camera angle and lighting the assistant picks (it never changes your flat)">
          <input type="checkbox" data-testid="follow-assistant" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow assistant view
        </label>
      )}
    </section>
  );
}
