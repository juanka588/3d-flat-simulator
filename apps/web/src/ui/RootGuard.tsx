import { Component } from 'react';
import type { ReactNode } from 'react';
import { useSceneStore } from '../state/sceneStore';
import { messageOf, useViewerHealth } from '../viewer/viewer-health';
import { downloadFlat } from './export-file';

/** Last resort around the whole app: a crash shows what happened and how to save the flat instead of a blank page. */
export class RootGuard extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown): void {
    useViewerHealth.getState().report({ source: 'app', message: messageOf(error), keptLastGood: false });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="viewer-error-banner" style={{ position: 'static', margin: '1rem' }} role="alert" data-testid="app-crash">
        <div>
          <strong>Something went wrong and the page stopped.</strong> {messageOf(this.state.error)} Your flat is autosaved in this browser; you can also export it before reloading.
        </div>
        <div className="buttons">
          <button type="button" className="link" onClick={() => downloadFlat(useSceneStore.getState().scene?.name ?? '')}>
            Export .flat.json
          </button>
          <button type="button" className="link" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
