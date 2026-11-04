import type { Renderer } from '../tools/registry';
import { blendControl } from './controlBlend';
import { ControlsUnavailableError, type ControlImageSource } from './wiring';
import type { ImageInput } from './types';

/**
 * The CG1 side of the control-image seam: the depth and the structural edges (depth and normal discontinuities, locked fittings
 * included, no texture lines) of the room camera, drawn by the viewer's render passes, blended into the one control image of the
 * Qwen Fun-ControlNet (the restyle spike's best setting: depth at 55 % with the edges white over it). One browser frame per call.
 *  - With a blockout (a scratch scene with layout placeholders, drawn as a preview, never committed) the placeholders are in it.
 *  - `solidWalls` (a view that sees no window): the wall pixels are drawn flat and their outlines stronger, so the model does not
 *    open a window in them.
 * When the depth pass is missing the canny edges alone are returned (the old control).
 */

const input = (dataUrl: string): ImageInput => ({ provenance: 'pass', data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png' });
const b64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);

export function passControlSource(renderer: Renderer): ControlImageSource {
  return {
    async getControlImages({ roomId, pose, size, blockout, solidWalls }) {
      const r = await renderer.render({ view: 'walk', roomId, pose, size }, { format: 'png', ...(blockout ? { scene: { epoch: 'blockout', rev: 0, scene: blockout } } : {}), passes: { kinds: ['edgesItems', 'depth', 'ids'] } });
      const edges = r.passes?.images['edgesItems'];
      const depth = r.passes?.images['depth'];
      const ids = r.passes?.images['ids'];
      if (!edges) throw new ControlsUnavailableError();
      const check = ids ? { check: { ids: input(ids), edges: input(edges) } } : {};
      if (!depth) return { canny: input(edges), ...check };
      try {
        const blend = blendControl(b64(depth), b64(edges), solidWalls && ids ? { idsPngB64: b64(ids) } : {});
        return { canny: input(edges), blend: { provenance: 'pass', data: blend, mimeType: 'image/png' }, ...check };
      } catch {
        // depth and edge passes that cannot be blended (unreadable or different sizes): the edges alone still steer the model
        return { canny: input(edges), ...check };
      }
    },
  };
}
