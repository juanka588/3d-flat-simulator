import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { MAX_SCENE_BYTES } from '@flat/scene';
import { beginLoad, isLatestLoad, useSceneStore } from './state/sceneStore';
import { FIXTURES } from './state/fixtures';
import { alignContext, contextFor } from './state/siteContext';
import { useViewStore } from './state/viewStore';
import { noteFrame, registerCanvas, testHookEnabled } from './testHook';
import { ErrorPanel } from './ui/ErrorPanel';
import { LightingPanel } from './ui/LightingPanel';
import { ModeToolbar } from './ui/ModeToolbar';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { SceneLoader } from './ui/SceneLoader';
import { SitePanel } from './ui/SitePanel';
import { WarningsList } from './ui/WarningsList';
import { FlatCanvas } from './viewer/FlatCanvas';
import { sceneKey } from './viewer/scene-identity';
import { selectionForId } from './viewer/selection';

/** Credit required by the Licence Ouverte 2.0 for the IGN BD TOPO buildings. */
export const CONTEXT_ATTRIBUTION = '© IGN – BD TOPO, Licence Ouverte 2.0';

export function App() {
  const { scene, source, warnings, errors, loadText } = useSceneStore();
  const { mode, selection, lighting, setMode, select } = useViewStore();
  const [dragging, setDragging] = useState(false);

  const loadFile = useCallback(
    async (file: File) => {
      const token = beginLoad();
      if (file.size > MAX_SCENE_BYTES) {
        useSceneStore.getState().fail([`file is larger than ${MAX_SCENE_BYTES / 1024 / 1024} MB`]);
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        if (isLatestLoad(token)) useSceneStore.getState().fail([`could not read ${file.name}`]);
        return;
      }
      // A newer load (another file, a fixture) started while this one was being read: it wins.
      if (isLatestLoad(token)) loadText(text, file.name);
    },
    [loadText],
  );

  const pickFixture = (id: string) => {
    const fixture = FIXTURES.find((f) => f.id === id);
    if (fixture) loadText(fixture.text, fixture.id);
  };

  const exitWalk = useCallback(() => {
    if (useViewStore.getState().mode === 'walk') setMode('orbit');
  }, [setMode]);

  // Leaving the page area while dragging must clear the drop affordance.
  useEffect(() => {
    const end = () => setDragging(false);
    window.addEventListener('dragend', end);
    return () => window.removeEventListener('dragend', end);
  }, []);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void loadFile(file);
  };

  const rawContext = contextFor(source);
  const site = scene?.site;
  // The generated context follows later Site edits: rotated/lifted to the new north and floor
  // elevation, hidden (with a hint) when the flat moved away from where it was generated.
  const { context, stale: contextStale } = useMemo(
    () => (rawContext && site ? alignContext(rawContext, site) : { context: rawContext, stale: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawContext, site?.latitude, site?.longitude, site?.northAngle, site?.floorElevation],
  );
  const fixtureId = FIXTURES.find((f) => f.id === source)?.id ?? '';

  return (
    <div
      className={dragging ? 'app dragging' : 'app'}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="sidebar">
        <h1>{scene?.name ?? '3D Flat Simulator'}</h1>
        <ModeToolbar mode={mode} onChange={setMode} />
        {mode === 'walk' && (
          <p className="hint">Click the view to look around, WASD or arrows to move, Esc to leave.</p>
        )}
        <SceneLoader fixtureId={fixtureId} onPickFixture={pickFixture} onFile={(f) => void loadFile(f)} />
        <ErrorPanel errors={errors} onDismiss={() => useSceneStore.setState({ errors: [] })} />
        {scene && <LightingPanel scene={scene} hasContext={rawContext !== null} />}
        {scene && <SitePanel key={sceneKey(scene)} scene={scene} />}
        {scene && (
          <WarningsList
            warnings={warnings}
            onSelect={(id) => select(selectionForId(scene, id))}
          />
        )}
      </header>
      <main className="stage">
        {scene && (
          <>
            <FlatCanvas
              scene={scene}
              view={{ mode, selection, lighting }}
              context={context}
              onSelect={select}
              onExitWalk={exitWalk}
              onCreated={registerCanvas}
              onFrame={testHookEnabled() ? noteFrame : undefined}
            />
            <PropertiesPanel scene={scene} selection={selection} />
            {contextStale && lighting.showContext && (
              <p className="context-hint" role="status" data-testid="context-stale">
                Site context out of date: re-run tools/site-context
              </p>
            )}
            {context && lighting.showContext && (
              <p className="attribution" data-testid="context-attribution">
                {CONTEXT_ATTRIBUTION}
              </p>
            )}
          </>
        )}
      </main>
      <div className="drop-overlay" aria-hidden="true">
        Drop a .flat.json to load it
      </div>
    </div>
  );
}
