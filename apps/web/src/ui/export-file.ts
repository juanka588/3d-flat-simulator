import { exportSceneText } from '../state/persistence';

export function fileNameFor(name: string): string {
  const slug = name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${slug || 'flat'}.flat.json`;
}

/** Downloads the current flat as a `.flat.json`; false when there is nothing to export. */
export function downloadFlat(name: string): boolean {
  const text = exportSceneText();
  if (text === null) return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFor(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
