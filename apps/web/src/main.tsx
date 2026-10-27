import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RootGuard } from './ui/RootGuard';
import { installDayClock } from './state/dayClock';
import { bootDocument, createBrowserAdapter, installAutosave } from './state/persistence';
import { startSync } from './sync/client';
import { installTestHook } from './testHook';
import './styles.css';

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
