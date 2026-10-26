import { eyeHeightM, MAX_PERSON_HEIGHT_CM, MIN_PERSON_HEIGHT_CM } from '../viewer/walk-camera';
import { useViewStore } from '../state/viewStore';
import { NumberField } from './NumberField';

/** View preferences (not part of the Scene): kept in localStorage. */
export function ViewSettings() {
  const personHeightCm = useViewStore((s) => s.personHeightCm);
  const setPersonHeightCm = useViewStore((s) => s.setPersonHeightCm);
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
    </section>
  );
}
