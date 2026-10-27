import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { MAX_SCENE_BYTES } from '@flat/scene';
import { beginLoad, isLatestLoad, useSceneStore } from './state/sceneStore';
import { DEFAULT_FIXTURE, FIXTURES } from './state/fixtures';
import { isDocumentDirty } from './state/persistence';
import { effectiveLighting } from './state/effectiveLighting';
import { alignContext, contextFor } from './state/siteContext';
import { readPref, writePref } from './state/prefs';
import { useViewStore } from './state/viewStore';
import { useViewportStore } from './state/viewport';
import { noteFrame, registerCanvas, testHookEnabled } from './testHook';
import { BootBanner } from './ui/BootBanner';
import { DocumentMenu } from './ui/DocumentMenu';
import { ErrorPanel } from './ui/ErrorPanel';
import { LightingPanel } from './ui/LightingPanel';
import { ModeToolbar } from './ui/ModeToolbar';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { SceneLoader } from './ui/SceneLoader';
import { SitePanel } from './ui/SitePanel';
import { SyncConflictDialog } from './ui/SyncConflictDialog';
import { SyncNotices } from './ui/SyncNotices';
import { SyncStatus } from './ui/SyncStatus';
import { useSyncStore } from './sync/sync-store';
import { useMobileLayout } from './ui/useMobileLayout';
import { useUndoRedoKeys } from './ui/useUndoRedoKeys';
import { ViewSettings } from './ui/ViewSettings';
import { WarningsList } from './ui/WarningsList';
import { FlatCanvas } from './viewer/FlatCanvas';
import { sceneKey } from './viewer/scene-identity';
import { selectionForId } from './viewer/selection';

/** Credit required by the Licence Ouverte 2.0 for the IGN BD TOPO buildings. */
export const CONTEXT_ATTRIBUTION = '© IGN – BD TOPO, Licence Ouverte 2.0';

/** Desktop: whether the sidebar is collapsed ('1') or shown ('0'). Remembered across visits. */
export const SIDEBAR_COLLAPSED_KEY = 'flat.sidebarCollapsed';

/**
 * Asks before discarding edits: a document that differs from the pristine sample (edits, an import, a
 * restored save). Connected to a scene server, loading also does `PUT /api/scene`, which replaces the
 * shared scene for every tab, so that always asks.
 */
function confirmReplace(): boolean {
  const sync = useSyncStore.getState();
  const shared = sync.mode === 'server' && sync.status === 'connected';
  if (!shared && !isDocumentDirty()) return true;
  return window.confirm(
    shared
      ? 'Replace the shared flat on the scene server? Every connected tab will switch to the new one (export the current one first to keep it).'
      : 'Replace the open flat? Your edits to it will be lost (export it first to keep them).',
  );
}

export function App() {
  useUndoRedoKeys();
  const { scene, source, warnings, errors, loadText } = useSceneStore();
  const { mode, selection, lighting, personHeightCm, walkLightsOn, translucentDoors, camera, setMode, select } = useViewStore();
  const viewport = useViewportStore((s) => s.forced);
  const clearCamera = useCallback(() => useViewStore.getState().setCamera(undefined), []);
  const [dragging, setDragging] = useState(false);
  const mobile = useMobileLayout();
  // Desktop: a collapsible column (remembered). Mobile: an overlay drawer that always starts closed.
  const [collapsed, setCollapsed] = useState(() => readPref(SIDEBAR_COLLAPSED_KEY) === '1');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuOpen = mobile ? drawerOpen : !collapsed;
  const sidebar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  const setMenuOpen = useCallback(
    (open: boolean, restoreFocus = false) => {
      if (mobile) setDrawerOpen(open);
      else {
        setCollapsed(!open);
        writePref(SIDEBAR_COLLAPSED_KEY, open ? '0' : '1');
      }
      if (restoreFocus && !open) toggle.current?.focus();
    },
    [mobile],
  );

  // Drawer focus management: focus moves into the drawer when it opens; Esc closes it (before the
  // walker sees the key) and returns focus to the menu button.
  useEffect(() => {
    if (mobile && drawerOpen) sidebar.current?.focus();
  }, [mobile, drawerOpen]);
  useEffect(() => {
    if (!mobile || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMenuOpen(false, true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mobile, drawerOpen, setMenuOpen]);

  const changeMode = (next: typeof mode) => {
    setMode(next);
    // The drawer covers the view: after choosing a camera mode the user wants to see it.
    if (mobile) setDrawerOpen(false);
  };

  const loadFile = useCallback(
    async (file: File, confirmed = false) => {
      if (!confirmed && !confirmReplace()) return;
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
    if (fixture && confirmReplace()) loadText(fixture.text, fixture.id);
  };

  const resetToSample = () => {
    if (confirmReplace()) loadText(DEFAULT_FIXTURE.text, DEFAULT_FIXTURE.id);
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
      className={['app', dragging && 'dragging', mobile ? 'mobile' : 'desktop', menuOpen ? 'menu-open' : 'menu-closed'].filter(Boolean).join(' ')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <button
        ref={toggle}
        type="button"
        className="menu-toggle"
        aria-label="Menu"
        aria-expanded={menuOpen}
        aria-controls="sidebar"
        title="Menu"
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <span aria-hidden="true">{mobile && menuOpen ? '✕' : '☰'}</span>
      </button>
      {mobile && menuOpen && <div className="backdrop" data-testid="backdrop" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
      <header
        id="sidebar"
        ref={sidebar}
        className="sidebar"
        tabIndex={-1}
        inert={!menuOpen}
        role={mobile ? 'dialog' : undefined}
        aria-modal={mobile && menuOpen ? true : undefined}
        aria-label={mobile ? 'Menu' : undefined}
      >
        <h1>{scene?.name ?? '3D Flat Simulator'}</h1>
        <SyncStatus />
        <ModeToolbar mode={mode} onChange={changeMode} />
        {mode === 'walk' && (
          <p className="hint">Click the view to look around, WASD or arrows to move, Esc to leave.</p>
        )}
        <ViewSettings />
        <SceneLoader fixtureId={fixtureId} onPickFixture={pickFixture} onFile={(f) => void loadFile(f)} />
        <DocumentMenu confirmReplace={confirmReplace} onImportFile={(f) => void loadFile(f, true)} onReset={resetToSample} />
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
        <BootBanner />
        {scene && (
          <>
            <FlatCanvas
              scene={scene}
              view={{ mode, selection, lighting: effectiveLighting(lighting, mode, walkLightsOn, scene.lights), personHeightCm, camera, translucentDoors }}
              context={context}
              onSelect={select}
              onExitWalk={exitWalk}
              onUserCamera={clearCamera}
              viewport={viewport}
              onCreated={registerCanvas}
              onFrame={testHookEnabled() ? noteFrame : undefined}
            />
            <PropertiesPanel scene={scene} selection={selection} sheet={mobile} hidden={mobile && mode === 'walk'} />
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
      <SyncNotices />
      <SyncConflictDialog />
      <div className="drop-overlay" aria-hidden="true">
        Drop a .flat.json to load it
      </div>
    </div>
  );
}
