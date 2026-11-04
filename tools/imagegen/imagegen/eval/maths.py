"""Pure maths of the coherence score: numpy + scipy only, no model, no file access. Every metric is 0..1, higher is better.

 depth     Spearman(monocular disparity of the image, our depth), clipped to 0..1
 edges     share of our structural edge pixels with a strong image gradient (top 10 %) within 8 px
 ceiling   IoU of the segmented 'ceiling' with the ceiling of our id pass
 open_rec  share of our expected openings that a classifier still sees as window or door (see score.py)
 extra     1 / (1 + n), n = window/door blobs of the image that touch no expected opening
 door_h    plain door under a visible ceiling: ratio (ceiling edge -> door foot) / door height vs ours
 aspect    1 - 5 |aspect / target - 1|
 score     mean of the available metrics
"""

from __future__ import annotations

from typing import Iterable, Sequence

import numpy as np
from scipy import ndimage as ndi

#: ADE20K label ids used with the UperNet segmentation.
CEIL, WIN, DOOR = 5, 8, 14
#: Palette of the id (layout) pass: class -> colour.
LAYOUT_PALETTE = {"ceiling": (199, 199, 255), "glass": (0, 170, 255), "door": (160, 32, 240)}
SCORE_KEYS = ("depth", "edges", "ceiling", "open_rec", "extra", "door_h", "aspect")


def rank(a: np.ndarray) -> np.ndarray:
    """Ordinal ranks (ties broken by position, as the spike did)."""
    o = np.argsort(a, kind="stable")
    r = np.empty(len(a))
    r[o] = np.arange(len(a))
    return r


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra, rb = rank(np.asarray(a).ravel()), rank(np.asarray(b).ravel())
    ra = ra - ra.mean()
    rb = rb - rb.mean()
    return float((ra * rb).sum() / (np.linalg.norm(ra) * np.linalg.norm(rb) + 1e-9))


def depth_score(disparity: np.ndarray, ref_depth: np.ndarray, samples: int = 60000, seed: int = 0) -> float:
    """Spearman on a fixed random subset of pixels (deterministic), clipped to 0..1. Both arrays: bright = near."""
    d, r = disparity.ravel(), ref_depth.ravel()
    if d.size > samples:
        idx = np.random.default_rng(seed).choice(d.size, samples, replace=False)
        d, r = d[idx], r[idx]
    return max(0.0, spearman(d, r))


def gradient_edges(gray: np.ndarray, percentile: float = 90.0, sigma: float = 1.2) -> np.ndarray:
    g = ndi.gaussian_filter(np.asarray(gray, dtype=np.float32), sigma)
    mag = np.hypot(ndi.sobel(g, 0), ndi.sobel(g, 1))
    return mag > np.percentile(mag, percentile)


def edge_recall(image_edges: np.ndarray, ref_edges: np.ndarray, tol: int = 8) -> float:
    """Share of the reference edge pixels that have an image edge within `tol` px."""
    near = ndi.binary_dilation(image_edges, iterations=tol)
    return float((near & ref_edges).sum() / max(1, ref_edges.sum()))


def palette_masks(rgb: np.ndarray, palette: dict[str, tuple[int, int, int]] = LAYOUT_PALETTE, tol: int = 40) -> dict[str, np.ndarray]:
    return {k: np.abs(rgb.astype(int) - np.array(c)).sum(-1) < tol for k, c in palette.items()}


def blobs(mask: np.ndarray, min_frac: float = 0.0) -> list[np.ndarray]:
    lab, n = ndi.label(mask)
    out = []
    for i in range(1, n + 1):
        m = lab == i
        if m.sum() >= min_frac * mask.size:
            out.append(m)
    return out


def bbox(m: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.where(m)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def opening_blobs(glass: np.ndarray, door: np.ndarray, min_frac: float = 0.002) -> list[np.ndarray]:
    """The expected openings of the id pass: connected glass or door regions."""
    return blobs(ndi.binary_closing(glass | door, iterations=3), min_frac)


def count_extra_openings(generated_open: np.ndarray, expected: Sequence[np.ndarray], min_frac: float = 0.004, grow: int = 25, overlap: float = 0.2) -> int:
    """Blobs of a window/door mask lying (less than `overlap` of their area) inside the expected openings grown by `grow` px."""
    gen = blobs(ndi.binary_opening(generated_open, iterations=2), min_frac)
    union = ndi.binary_dilation(np.any(expected, axis=0) if len(expected) else np.zeros_like(generated_open), iterations=grow)
    return sum(1 for b in gen if (b & union).sum() / b.sum() < overlap)


def extra_score(n: int) -> float:
    return 1.0 / (1 + n)


def aspect_score(width: int, height: int, target: float = 4 / 3) -> float:
    return max(0.0, 1 - 5 * abs((width / height) / target - 1))


def door_ratio(ceil: np.ndarray, door_mask: np.ndarray) -> float | None:
    """(ceiling edge -> door foot) / door height at the door's central columns; None when unmeasurable."""
    ys, xs = np.where(door_mask)
    if len(xs) == 0:
        return None
    x0, x1 = np.percentile(xs, [35, 65]).astype(int)
    rs = []
    for x in range(x0, x1 + 1):
        col = door_mask[:, x]
        if not col.any():
            continue
        top, foot = np.where(col)[0].min(), np.where(col)[0].max()
        c = np.where(ceil[:top, x])[0]
        if len(c) == 0 or foot - top < 20:
            continue
        rs.append((foot - c.max()) / (foot - top))
    return float(np.median(rs)) if rs else None


def iou(a: np.ndarray, b: np.ndarray) -> float:
    return float((a & b).sum() / max(1, (a | b).sum()))


def aggregate(scores: dict) -> float:
    """Mean of the metrics present among SCORE_KEYS."""
    vals = [scores[k] for k in SCORE_KEYS if scores.get(k) is not None]
    return float(np.mean(vals)) if vals else 0.0


def rounded(d: dict) -> dict:
    return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items()}


def mean_table(per_view: dict[str, dict[str, dict | None]], columns: Iterable[str]) -> str:
    """Markdown table: rows = views, columns = methods (score), then mean score, mean extra openings, mean opening recall."""
    cols = list(columns)
    lines = ["| view | " + " | ".join(cols) + " |", "|" + "---|" * (len(cols) + 1)]
    for v, by in per_view.items():
        lines.append(f"| {v} | " + " | ".join(f"{by[c]['score']:.2f}" if by.get(c) else "-" for c in cols) + " |")

    def mean(key: str, fmt: str) -> str:
        out = []
        for c in cols:
            xs = [by[c].get(key, 0.0) for by in per_view.values() if by.get(c)]
            out.append(format(sum(xs) / len(xs), fmt) if xs else "-")
        return " | ".join(out)

    lines.append("| **mean** | " + mean("score", ".2f") + " |")
    lines.append("| **mean extra openings** | " + mean("extra_n", ".1f") + " |")
    lines.append("| **mean opening recall** | " + mean("open_rec", ".2f") + " |")
    return "\n".join(lines)
