import type { Renderer } from '../tools/registry';
import { ControlsUnavailableError, type ControlImageSource } from './wiring';
import type { ImageInput } from './types';

/**
 * The CG1 side of the control-image seam: structural edges (depth and normal discontinuities only, no texture lines) and the
 * depth visualisation of the room camera, drawn by the viewer's render passes. One browser frame per call.
 */

const input = (dataUrl: string): ImageInput => ({ provenance: 'pass', data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png' });

export function passControlSource(renderer: Renderer): ControlImageSource {
  return {
    async getControlImages({ roomId, pose, size }) {
      const r = await renderer.render({ view: 'walk', roomId, pose, size }, { format: 'png', passes: { kinds: ['edges', 'depthVis'] } });
      const edges = r.passes?.images['edges'];
      if (!edges) throw new ControlsUnavailableError();
      const depth = r.passes?.images['depthVis'];
      return { canny: input(edges), ...(depth ? { depth: input(depth) } : {}) };
    },
  };
}
