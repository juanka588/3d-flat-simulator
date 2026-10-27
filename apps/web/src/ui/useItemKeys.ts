import { useEffect } from 'react';
import { flashNotice } from '../catalog/catalogStore';
import { itemName } from '../catalog/format';
import { commandForKey, itemCoalesceKey, itemKeyAction } from '../catalog/place';
import { keyVerdict } from '../catalog/key-check';
import { isDragging } from '../catalog/placement';
import { committedScene, useSceneStore } from '../state/sceneStore';
import { useViewStore } from '../state/viewStore';

/** Controls that always keep their own keys (arrows move the caret / a slider / between tabs; Delete edits text). */
const FIELD_TAGS = ['INPUT', 'SELECT', 'TEXTAREA'];
const OWN_ROLES = ['slider', 'tab', 'tablist', 'listbox', 'option', 'menu', 'menuitem', 'radio', 'radiogroup', 'spinbutton', 'textbox', 'combobox', 'switch', 'checkbox'];
/** Buttons and links keep their keys too, except inside the regions that mean "I am working on the scene". */
const ACTION_TAGS = ['BUTTON', 'A', 'SUMMARY'];
/** Marks the regions whose focused buttons still drive the selected item: the room item list. */
export const ITEM_KEYS_ATTR = 'data-item-keys';

/**
 * Whether the keyboard focus is somewhere the item keys apply: the page itself, the 3D canvas, a plain container
 * (the sidebar the app focuses programmatically), or an item button in the room item list (`data-item-keys`).
 * A focused input, select, tab, slider, link or other button keeps its own keys.
 */
export function itemKeysApply(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return true;
  if (el.isContentEditable || FIELD_TAGS.includes(el.tagName)) return false;
  const role = el.getAttribute?.('role');
  if (role && OWN_ROLES.includes(role)) return false;
  if (ACTION_TAGS.includes(el.tagName)) return !!el.closest?.(`[${ITEM_KEYS_ATTR}]`);
  return true;
}

/**
 * Keyboard editing of the selected item: R rotates 90°, Delete removes, arrows nudge 1 cm (Shift: 5 cm). Only while
 * the canvas (or the page background) has the focus. A nudge or rotation runs the same full check as the drag ghost
 * and is refused with its message when the ghost would be red (the reducer alone enforces fewer rules).
 */
export function useItemKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = itemKeyAction(e);
      if (!action || !itemKeysApply(e.target) || isDragging()) return;
      const view = useViewStore.getState();
      if (view.mode === 'walk' || view.selection?.kind !== 'item') return;
      const store = useSceneStore.getState();
      const scene = committedScene(store);
      const item = scene?.items.find((i) => i.id === view.selection!.entityId);
      if (!scene || !item) return;
      e.preventDefault();
      if (item.locked) return flashNotice(`${itemName(item)} is locked: unlock it to change it.`);
      const verdict = keyVerdict(scene, item, action);
      if (verdict && !verdict.valid) return flashNotice(`Can't ${action.kind === 'rotate' ? 'rotate' : 'move'} ${itemName(item)}: ${verdict.message}`);
      const c = commandForKey(item, action);
      if (!c) return;
      const result = store.dispatch(c.cmd, { ...(c.coalesce ? { coalesceKey: itemCoalesceKey(item.id) } : {}), label: `${action.kind === 'remove' ? 'Remove' : action.kind === 'rotate' ? 'Rotate' : 'Nudge'} ${itemName(item)}` });
      if (!result.ok) flashNotice(`Can't do that: ${result.errors[0]?.message ?? 'refused'}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
