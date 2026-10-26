import { useId, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { FIXTURES } from '../state/fixtures';

interface SceneLoaderProps {
  /** Currently loaded fixture id, or '' for a file. */
  fixtureId: string;
  onPickFixture: (id: string) => void;
  onFile: (file: File) => void;
}

export function SceneLoader({ fixtureId, onPickFixture, onFile }: SceneLoaderProps) {
  const selectId = useId();
  const input = useRef<HTMLInputElement>(null);

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    e.target.value = ''; // allow re-selecting the same file
  };

  return (
    <section aria-label="Scene source" className="panel">
      <label htmlFor={selectId}>Flat</label>
      <select id={selectId} value={fixtureId} onChange={(e) => onPickFixture(e.target.value)}>
        {fixtureId === '' && <option value="">(loaded file)</option>}
        {FIXTURES.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => input.current?.click()}>
        Open file…
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        aria-label="Open a .flat.json file"
        data-testid="file-input"
        hidden
        onChange={handleFile}
      />
      <p className="hint">or drop a .flat.json anywhere</p>
    </section>
  );
}
