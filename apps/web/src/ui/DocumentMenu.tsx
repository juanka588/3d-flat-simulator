import { useRef } from 'react';
import type { ChangeEvent } from 'react';
import { useDocumentStatus } from '../state/persistence';
import { useSceneStore } from '../state/sceneStore';
import { downloadFlat } from './export-file';

interface DocumentMenuProps {
  /** Asks before replacing a document that has edits; resolves false to cancel. */
  confirmReplace: () => boolean;
  onImportFile: (file: File) => void;
  onReset: () => void;
}

function statusText(state: ReturnType<typeof useDocumentStatus.getState>): string {
  switch (state.autosave) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Autosaved';
    case 'paused':
      return state.pause === 'loading' ? 'Loading saved flat…' : 'Autosave paused';
    case 'unavailable':
      return `Autosave unavailable (${state.reason ?? 'storage error'})`;
    default:
      return 'Autosave on';
  }
}

/** Document actions: export / import a .flat.json, reset to the sample flat, and the autosave status. */
export function DocumentMenu({ confirmReplace, onImportFile, onReset }: DocumentMenuProps) {
  const input = useRef<HTMLInputElement>(null);
  const status = useDocumentStatus();
  const name = useSceneStore((s) => s.scene?.name ?? '');
  const hasScene = useSceneStore((s) => s.scene !== null);

  const exportFile = () => {
    downloadFlat(name);
  };

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImportFile(file);
    e.target.value = '';
  };

  const importClick = () => {
    if (confirmReplace()) input.current?.click();
  };

  return (
    <section aria-label="Document" className="panel document-menu" data-testid="document-menu">
      <h2>Document</h2>
      <div className="button-row">
        <button type="button" disabled={!hasScene} onClick={exportFile}>
          Export .flat.json
        </button>
        <button type="button" onClick={importClick}>
          Import…
        </button>
        <button type="button" onClick={onReset}>
          Reset to sample
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        aria-label="Import a .flat.json file"
        data-testid="import-input"
        hidden
        onChange={handleFile}
      />
      <p className="hint" role="status" data-testid="autosave-status" data-state={status.autosave}>
        {statusText(status)}
      </p>
    </section>
  );
}
