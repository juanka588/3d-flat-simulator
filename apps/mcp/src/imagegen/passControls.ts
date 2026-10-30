import type { Renderer } from '../tools/registry';
import { blendControl } from './controlBlend';
import { ControlsUnavailableError, type ControlImageSource } from './wiring';
import type { ImageInput } from './types';

/**
 * The CG1 side of the control-image seam: structural edges (depth and normal discontinuities only, no texture lines) and the
 * depth of the room camera, drawn by the viewer's render passes. One browser frame per call.
 *  - Without a blockout: the structural edges of the real scene (canny control).
 *  - With a blockout (a scratch scene with layout placeholders, drawn as a preview, never committed): the depth and the edges
 *    including items, blended into one control image.
 */

const input = (dataUrl: string): ImageInput => ({ provenance: 'pass', data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png' });
const b64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);

export function passControlSource(renderer: Renderer): ControlImageSource {
  return {
    async getControlImages({ roomId, pose, size, blockout }) {
      if (blockout) {
        const r = await renderer.render({ view: 'walk', roomId, pose, size }, { format: 'png', scene: { epoch: 'blockout', rev: 0, scene: blockout }, passes: { kinds: ['edgesItems', 'depth', 'ids'] } });
        const edges = r.passes?.images['edgesItems'];
        const depth = r.passes?.images['depth'];
        const ids = r.passes?.images['ids'];
        if (!edges || !depth) throw new ControlsUnavailableError();
        return { canny: input(edges), blend: { provenance: 'pass', data: blendControl(b64(depth), b64(edges)), mimeType: 'image/png' }, ...(ids ? { check: { ids: input(ids), edges: input(edges) } } : {}) };
      }
      const r = await renderer.render({ view: 'walk', roomId, pose, size }, { format: 'png', passes: { kinds: ['edges', 'depthVis', 'ids'] } });
      const edges = r.passes?.images['edges'];
      if (!edges) throw new ControlsUnavailableError();
      const depth = r.passes?.images['depthVis'];
      const ids = r.passes?.images['ids'];
      return { canny: input(edges), ...(depth ? { depth: input(depth) } : {}), ...(ids ? { check: { ids: input(ids), edges: input(edges) } } : {}) };
    },
  };
}
