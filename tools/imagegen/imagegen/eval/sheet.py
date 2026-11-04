"""Contact sheets: one row of columns per view (our render, edges, then one column per method / seed), optionally with scores.

`--columns name=dir,...`: each dir holds images named `<view>.<ext>` or `<view>-<suffix>.<ext>` (e.g. `3-kitchen-s3205.png`); several
matches give one column each, labelled `name suffix`. Sheets are written to `--out` (a directory, or a single file with one view);
with `--score` the metrics are drawn under each image and a markdown table of the means is written to <out>/scores-table.md.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import maths as M
from .inputs import EXTS, find_pass, list_views
from .score import Reference, score_image

CW, CH = 480, 360


def parse_columns(spec: str) -> list[tuple[str, Path]]:
    cols = []
    for part in [s for s in spec.split(",") if s.strip()]:
        name, sep, d = part.partition("=")
        if not sep or not name.strip() or not d.strip():
            raise SystemExit(f"--columns expects name=dir,name=dir (got {part!r})")
        cols.append((name.strip(), Path(d.strip()).expanduser()))
    return cols


def find_images(d: Path, view: str) -> list[tuple[str, Path]]:
    """[(suffix, path)] for the images of `view` in `d`; suffix is '' for an exact name."""
    out = []
    if not d.is_dir():
        return out
    for p in sorted(d.iterdir()):
        if p.suffix.lower() not in EXTS:
            continue
        if p.stem == view:
            out.append(("", p))
        elif p.stem.startswith(view + "-"):
            out.append((p.stem[len(view) + 1 :], p))
    return out


def view_columns(views: Path, view: str, columns: list[tuple[str, Path]], passes: bool = True) -> list[tuple[str, Path]]:
    cols: list[tuple[str, Path]] = []
    if passes:
        for label, kind in (("our render", "base"), ("edges", "edges")):
            p = find_pass(views / view, kind)
            if p:
                cols.append((label, p))
    for name, d in columns:
        found = find_images(d, view)
        cols += [(f"{name} {suf}".strip(), p) for suf, p in found]
    return cols


def _font(size: int):
    for f in ("/System/Library/Fonts/Helvetica.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def draw_sheet(cols: list[tuple[str, Path, dict | None]], out: Path) -> None:
    font, fontb = _font(15), _font(17)
    img = Image.new("RGB", (CW * max(1, len(cols)), CH + 90), "white")
    d = ImageDraw.Draw(img)
    for i, (name, p, s) in enumerate(cols):
        im = Image.open(p).convert("RGB")
        im.thumbnail((CW, CH))
        img.paste(im, (i * CW + (CW - im.width) // 2, 0))
        x = i * CW + 6
        d.text((x, CH + 4), name, fill="black", font=fontb)
        if s:
            d.text((x, CH + 26), f"score {s['score']:.2f}  depth {s['depth']:.2f}  edges {s['edges']:.2f}", fill="black", font=font)
            d.text((x, CH + 46), f"ceiling {s['ceiling']:.2f}  open.rec {s.get('open_rec', 0):.2f}  extra openings {s['extra_n']}", fill="black", font=font)
            dr = s.get("door_ratio")
            d.text((x, CH + 66), f"door/ceil {dr if dr is not None else 'n/a'} (ours {s.get('door_ratio_ref', 'n/a')})", fill="black", font=font)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, quality=88)


def make_sheets(views: Path, columns: list[tuple[str, Path]], out: Path, only: list[str] | None = None, score: bool = False, cache_file: Path | None = None,
                estimators=None) -> dict:  # noqa: ANN001
    """Draw one sheet per view; returns {view: {label: scores|None}}."""
    names = list_views(views, only)
    single_file = out.suffix.lower() in (".jpg", ".jpeg", ".png")
    if single_file and len(names) != 1:
        raise SystemExit("--out is a file but several views are selected: use a directory or --view NAME")
    cache = json.loads(cache_file.read_text()) if cache_file and cache_file.exists() else {}
    per_view: dict[str, dict] = {}
    for v in names:
        cols = view_columns(views, v, columns)
        ref = None
        by: dict[str, dict | None] = {}
        drawn = []
        for label, p in cols:
            s = None
            if score and label not in ("our render", "edges"):
                key = f"{v}|{label}"
                if key not in cache:
                    if ref is None:
                        ids, dep, edg = find_pass(views / v, "ids"), find_pass(views / v, "depth"), find_pass(views / v, "edges")
                        if not (ids and dep and edg):
                            raise SystemExit(f"{views / v}: scoring needs depth, edges and ids passes")
                        ref = Reference.load(dep, edg, ids, find_pass(views / v, "base"))
                    cache[key] = score_image(ref, Image.open(p), estimators)
                    if cache_file:
                        cache_file.parent.mkdir(parents=True, exist_ok=True)
                        cache_file.write_text(json.dumps(cache, indent=1))
                s = cache[key]
            by[label] = s
            drawn.append((label, p, s))
        per_view[v] = by
        draw_sheet(drawn, out if single_file else out / f"{v}.jpg")
        print(f"sheet {v}: {len(drawn)} columns")
    if score and not single_file:
        labels = list(dict.fromkeys(label for by in per_view.values() for label in by if label not in ("our render", "edges")))
        table = M.mean_table(per_view, labels)
        (out / "scores-table.md").write_text(table + "\n")
        print(table)
    return per_view
