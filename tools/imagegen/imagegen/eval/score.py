"""Score a restyled image against the passes of our render (see maths.py for the metrics).

References (all from `render_passes` / the views sheet of one camera, same framing as the restyled image):
  depth  depth pass as 8-bit grey, bright = near
  edges  edge pass, black lines on white
  ids    id/layout pass: palette colours for ceiling, glass and door (anything below the frame, e.g. a legend, is cropped)
  render the plain render, only used for its aspect ratio (the score's aspect target); 4:3 without it
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from . import maths as M

FRAME_W = 1024


class Estimators(Protocol):
    def disparity(self, img: Image.Image) -> np.ndarray: ...
    def segment(self, img: Image.Image) -> np.ndarray: ...
    def opening_recall(self, img: Image.Image, boxes: list[tuple[int, int, int, int]]) -> float | None: ...


def load_rgb(p: Path | str) -> Image.Image:
    return Image.open(p).convert("RGB")


@dataclass
class Reference:
    """Reference passes resampled to the comparison frame (FRAME_W wide, height from the depth pass)."""

    depth: np.ndarray
    edges: np.ndarray
    ceiling: np.ndarray
    glass: np.ndarray
    door: np.ndarray
    opens: list[np.ndarray]
    aspect: float
    size: tuple[int, int]

    @classmethod
    def load(cls, depth: Path, edges: Path, ids: Path, render: Path | None = None) -> "Reference":
        d = load_rgb(depth)
        size = (FRAME_W, round(FRAME_W * d.height / d.width))
        return cls.from_images(d, load_rgb(edges), load_rgb(ids), load_rgb(render) if render else None, size)

    @classmethod
    def from_images(cls, depth: Image.Image, edges: Image.Image, ids: Image.Image, render: Image.Image | None, size: tuple[int, int]) -> "Reference":
        dep = np.asarray(depth.convert("L").resize(size), dtype=np.float32)
        e = np.asarray(edges.convert("L").resize(size, Image.LANCZOS)) < 160
        keep = min(ids.height, round(ids.width * size[1] / size[0]))  # the id pass may carry a legend below the frame
        masks = {k: np.asarray(Image.fromarray((v * 255).astype(np.uint8)).resize(size, Image.NEAREST)) > 127 for k, v in M.palette_masks(np.asarray(ids)[:keep]).items()}
        opens = M.opening_blobs(masks["glass"], masks["door"])
        aspect = (render.width / render.height) if render else 4 / 3
        return cls(dep, e, masks["ceiling"], masks["glass"], masks["door"], opens, aspect, size)


def score_image(ref: Reference, img: Image.Image, est: Estimators) -> dict:
    """All metrics of one image. `img` is resampled to the reference frame for the comparison."""
    r: dict = {"aspect": M.aspect_score(img.width, img.height, ref.aspect)}
    iv = img.convert("RGB").resize(ref.size)
    r["depth"] = M.depth_score(est.disparity(iv), ref.depth)
    r["edges"] = M.edge_recall(M.gradient_edges(np.asarray(iv.convert("L"))), ref.edges)
    seg = est.segment(iv)
    ceil = seg == M.CEIL
    r["ceiling"] = M.iou(ceil, ref.ceiling)
    oc = est.opening_recall(iv, [M.bbox(b) for b in ref.opens])
    if oc is not None:
        r["open_rec"] = oc
    r["extra_n"] = M.count_extra_openings((seg == M.WIN) | (seg == M.DOOR), ref.opens)
    r["extra"] = M.extra_score(r["extra_n"])
    # door height: the largest plain door (door pixels, hardly any glass) of the id pass
    plain = [b for b in ref.opens if (b & ref.glass).sum() < 0.05 * b.sum() and b.sum() > 0.003 * b.size]
    if plain:
        b = max(plain, key=lambda m: m.sum())
        rr = M.door_ratio(ref.ceiling, b)
        if rr:
            gd = [g for g in M.blobs(seg == M.DOOR, 0.002) if (ndi.binary_dilation(g, iterations=15) & b).any()]
            rg = M.door_ratio(ceil, max(gd, key=lambda m: (m & ndi.binary_dilation(b, iterations=20)).sum())) if gd else None
            r["door_ratio_ref"] = round(rr, 3)
            r["door_ratio"] = None if rg is None else round(rg, 3)
            if rg is not None:
                r["door_h"] = max(0.0, 1 - abs(rg / rr - 1))
    r["score"] = M.aggregate(r)
    return M.rounded(r)
