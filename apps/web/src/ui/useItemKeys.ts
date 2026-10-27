import { useEffect } from 'react';
import { flashNotice } from '../catalog/catalogStore';
import { itemName } from '../catalog/format';
import { commandForKey, itemCoalesceKey, itemKeyAction } from '../catalog/place';
import { isDragging } from '../catalog/placement';
import { committedScene, useSceneStore } from '../state/sceneStore';
import { useViewStore } from '../state/viewStore';

/** Fields where the arrow keys and Delete belong to the field. */
function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.getAttribute('role') === 'slider';
}

/** Keyboard editing of the selected item: R rotates 90°, Delete removes, arrows nudge 1 cm (Shift: 5 cm). */
export function useItemKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = itemKeyAction(e);
      if (!action || inField(e.target) || isDragging()) return;
      const view = useViewStore.getState();
      if (view.mode === 'walk' || view.selection?.kind !== 'item') return;
      const store = useSceneStore.getState();
      const scene = committedScene(store);
      const item = scene?.items.find((i) => i.id === view.selection!.entityId);
      if (!scene || !item) return;
      e.preventDefault();
      if (item.locked) return flashNotice(`${itemName(item)} is locked: unlock it to change it.`);
      const c = commandForKey(item, action);
      if (!c) return;
      const result = store.dispatch(c.cmd, { ...(c.coalesce ? { coalesceKey: itemCoalesceKey(item.id) } : {}), label: `${action.kind === 'remove' ? 'Remove' : action.kind === 'rotate' ? 'Rotate' : 'Nudge'} ${itemName(item)}` });
      if (!result.ok) flashNotice(`Can't do that: ${result.errors[0]?.message ?? 'refused'}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
