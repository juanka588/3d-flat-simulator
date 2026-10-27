import { flashNotice } from '../catalog/catalogStore';
import { prepareExport, violationMessage } from '../state/export-guard';
import { exportSceneText } from '../state/persistence';

export function fileNameFor(name: string): string {
  const slug = name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${slug || 'flat'}.flat.json`;
}

/**
 * Downloads the current flat as a `.flat.json`; false when there is nothing to export OR the export guard refused it
 * (photos, models or foreign URLs in the document; the user is told why).
 */
export function downloadFlat(name: string): boolean {
  const text = exportSceneText();
  if (text === null) return false;
  const prepared = prepareExport(text);
  if (!prepared.ok) {
    flashNotice(`Export refused. ${violationMessage(prepared.violations)}`, 12_000);
    return false;
  }
  const url = URL.createObjectURL(new Blob([prepared.text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFor(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
