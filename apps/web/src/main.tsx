import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { assertGeneratorsRegistered } from '@flat/assets';
import './viewer-config';
import { App } from './App';
import { RootGuard } from './ui/RootGuard';
import { installDayClock } from './state/dayClock';
import { bootDocument, createBrowserAdapter, installAutosave } from './state/persistence';
import { startSync } from './sync/client';
import { installTestHook } from './testHook';
import './styles.css';

// Importing @flat/assets registers the generators in scene's registry (scene does not); fail loudly if that breaks.
assertGeneratorsRegistered();
installTestHook();
installDayClock();

const storage = createBrowserAdapter();
// Restore the autosaved flat (or the default one, with a banner saying why), then start saving.
await bootDocument(storage);
installAutosave(storage);
// Live sync with a scene server, only when one is configured (?server=) or, in dev, found.
void startSync();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootGuard>
      <App />
    </RootGuard>
  </StrictMode>,
);
