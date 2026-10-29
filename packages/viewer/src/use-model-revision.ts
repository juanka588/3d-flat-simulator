import { useEffect, useState } from 'react';
import { activeModelController, subscribeActiveController } from './model-runtime';

/**
 * Re-renders when the model controller reports a change (a model arrived or fell back). It follows the ACTIVE
 * controller: when the viewer remounts and a new controller replaces the old one, the subscription moves too.
 */
export function useModelRevision(): number {
  const [rev, setRev] = useState(0);
  const [controller, setController] = useState(activeModelController);
  useEffect(() => {
    const follow = () => {
      setController(activeModelController());
      setRev((r) => r + 1);
    };
    follow();
    return subscribeActiveController(follow);
  }, []);
  useEffect(() => controller?.subscribe(() => setRev((r) => r + 1)), [controller]);
  return rev;
}
