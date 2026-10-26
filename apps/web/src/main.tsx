import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useSceneStore } from './state/sceneStore';
import { DEFAULT_FIXTURE } from './state/fixtures';
import { installTestHook } from './testHook';
import './styles.css';

installTestHook();
useSceneStore.getState().loadText(DEFAULT_FIXTURE.text, DEFAULT_FIXTURE.id);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
