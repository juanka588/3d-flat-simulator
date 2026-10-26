import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installDayClock } from './state/dayClock';
import { bootDocument, createBrowserAdapter, installAutosave } from './state/persistence';
import { installTestHook } from './testHook';
import './styles.css';

installTestHook();
installDayClock();

const storage = createBrowserAdapter();
// Restore the autosaved flat (or the default one, with a banner saying why), then start saving.
await bootDocument(storage);
installAutosave(storage);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
