"""Per-view model inputs from the passes of our render.

A views directory holds one folder per view with the passes of `render_passes` / `pnpm mcp:views-sheet`:
  <views>/<view>/render.png (or base.png), depth.png (bright = near), edges.png (black lines), ids.png (or layout.png)
`make_inputs` writes <out>/<view>/{base,depth,edges,control}.png at one size; prompt.txt (and negative.txt) are left to the
caller (the reference prompt builder of apps/mcp writes them; `generate` reads them).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

ALIASES = {"base": ("render", "base"), "depth": ("depth",), "edges": ("edges",), "ids": ("ids", "layout")}
EXTS = (".png", ".jpg", ".jpeg", ".webp")


def find_pass(view_dir: Path, kind: str) -> Path | None:
    for stem in ALIASES[kind]:
        for ext in EXTS:
            p = view_dir / f"{stem}{ext}"
            if p.is_file():
                return p
    return None


def list_views(root: Path, only: list[str] | None = None) -> list[str]:
    if not root.is_dir():
        raise SystemExit(f"not a directory: {root}")
    names = sorted(d.name for d in root.iterdir() if d.is_dir() and not d.name.startswith("."))
    if only:
        missing = [n for n in only if n not in names]
        if missing:
            raise SystemExit(f"no such view folder under {root}: {', '.join(missing)}")
        return only
    return names


def control_blend(depth: np.ndarray, edges: np.ndarray, depth_gain: float = 0.55) -> np.ndarray:
    """The single Qwen ControlNet control image (same as apps/mcp controlBlend.ts): depth (2nd..98th percentile, gamma 0.5,
    near = bright) at `depth_gain` brightness with the structural edges drawn white, 2 px wide, over it. Returns uint8 HxW."""
    g = depth.astype(np.float32)
    lo, hi = np.percentile(g, [2, 98])
    t = np.clip((g - lo) / max(hi - lo, 1e-6), 0, 1)
    gray = np.sqrt(t) * 255 * depth_gain
    e = edges < 200
    e2 = e | np.pad(e, ((0, 0), (1, 0)))[:, :-1] | np.pad(e, ((1, 0), (0, 0)))[:-1] | np.pad(e, ((1, 0), (1, 0)))[:-1, :-1]
    return np.where(e2, 255, np.floor(gray)).astype(np.uint8)


def make_inputs(views: Path, out: Path, only: list[str] | None = None, size: tuple[int, int] = (1024, 768)) -> list[str]:
    done = []
    for v in list_views(views, only):
        vd = views / v
        paths = {k: find_pass(vd, k) for k in ("base", "depth", "edges")}
        missing = [k for k, p in paths.items() if p is None]
        if missing:
            print(f"{v}: skipped, missing {', '.join(missing)}")
            continue
        d = out / v
        d.mkdir(parents=True, exist_ok=True)
        base = Image.open(paths["base"]).convert("RGB").resize(size, Image.LANCZOS)
        dep = Image.open(paths["depth"]).convert("L").resize(size, Image.LANCZOS)
        edg = Image.open(paths["edges"]).convert("L").resize(size, Image.LANCZOS)
        base.save(d / "base.png")
        dep.convert("RGB").save(d / "depth.png")
        edg.convert("RGB").save(d / "edges.png")
        Image.fromarray(control_blend(np.asarray(dep), np.asarray(edg))).convert("RGB").save(d / "control.png")
        done.append(v)
        print(f"{v}: ok")
    return done
