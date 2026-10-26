import { useSyncExternalStore } from 'react';

/** Phone / tablet layout: a narrow viewport, or a touch screen as the primary pointer. */
export const MOBILE_QUERY = '(max-width: 767px), (pointer: coarse)';

function subscribe(notify: () => void): () => void {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener('change', notify);
  return () => mq.removeEventListener('change', notify);
}

const snapshot = () => window.matchMedia(MOBILE_QUERY).matches;

/** True in the mobile layout (see `MOBILE_QUERY`); follows rotation and window resizes. */
export function useMobileLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
