"""`python -m imagegen.eval {score,sheet,inputs,generate}` (via `pnpm imagegen:eval -- <command> ...`). See docs/research/cg-restyle-spike.md."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _csv(s: str | None) -> list[str] | None:
    return [x.strip() for x in s.split(",") if x.strip()] if s else None


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m imagegen.eval", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("score", help="score restyled images against the passes of our render (extra `eval`)")
    s.add_argument("--render", help="our plain render (only its aspect ratio is used; default target 4:3)")
    s.add_argument("--edges", required=True, help="edge pass (black lines on white)")
    s.add_argument("--depth", required=True, help="depth pass, grey, bright = near")
    s.add_argument("--ids", required=True, help="id/layout pass (palette: ceiling, glass, door)")
    s.add_argument("--image", required=True, nargs="+", help="restyled image(s) to score")
    s.add_argument("--json", action="store_true", help="print JSON {image: metrics} (default: a table)")
    s.add_argument("--download", action="store_true", help="allow fetching the three small models (offline by default)")

    h = sub.add_parser("sheet", help="contact sheets of our render, edges and one column per method")
    h.add_argument("--views", required=True, help="directory with one folder of passes per view")
    h.add_argument("--columns", required=True, help="name=dir,name=dir: directories holding <view>[-suffix].png")
    h.add_argument("--out", required=True, help="output directory (or one image file with a single --view)")
    h.add_argument("--view", help="comma-separated view names (default: all)")
    h.add_argument("--score", action="store_true", help="draw metrics under each image and write scores-table.md")
    h.add_argument("--cache", help="JSON file caching scores between runs")
    h.add_argument("--download", action="store_true")

    i = sub.add_parser("inputs", help="write base/depth/edges/control images per view for the generators")
    i.add_argument("--views", required=True)
    i.add_argument("--out", required=True)
    i.add_argument("--view")
    i.add_argument("--size", default="1024x768")

    g = sub.add_parser("generate", help="run a generation method over the inputs with the sidecar's mflux commands")
    g.add_argument("--method", required=True, choices=["qwen-cn", "qwen21-edit", "klein"])
    g.add_argument("--inputs", required=True)
    g.add_argument("--out", required=True)
    g.add_argument("--seeds", default="3205,4242")
    g.add_argument("--view")
    g.add_argument("--steps", type=int)
    g.add_argument("--size", default="1024x768")
    g.add_argument("--dry", action="store_true", help="print the mflux commands only")
    g.add_argument("--force", action="store_true", help="run even when memory headroom looks too small")
    g.add_argument("--download", action="store_true")
    return ap


def _size(s: str) -> tuple[int, int]:
    try:
        w, h = s.lower().split("x")
        return int(w), int(h)
    except ValueError:
        raise SystemExit(f"--size expects WxH (got {s!r})")


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    if a.cmd == "inputs":
        from .inputs import make_inputs

        make_inputs(Path(a.views), Path(a.out), _csv(a.view), _size(a.size))
        return 0
    if a.cmd == "generate":
        from .generate import run

        return run(a.method, Path(a.inputs), Path(a.out), [int(x) for x in a.seeds.split(",")], _csv(a.view), download=a.download, dry=a.dry, force=a.force,
                   steps=a.steps, size=_size(a.size))
    from .models import Estimators, configure_hf

    configure_hf(a.download)
    if a.cmd == "score":
        from PIL import Image

        from .score import Reference, score_image

        ref = Reference.load(Path(a.depth), Path(a.edges), Path(a.ids), Path(a.render) if a.render else None)
        est = Estimators()
        res = {p: score_image(ref, Image.open(p), est) for p in a.image}
        if a.json:
            print(json.dumps(res, indent=1))
        else:
            keys = ["score", "depth", "edges", "ceiling", "open_rec", "extra_n", "door_h", "aspect"]
            print("image | " + " | ".join(keys))
            for p, r in res.items():
                print(f"{p} | " + " | ".join(str(r.get(k, "-")) for k in keys))
        return 0
    from .sheet import make_sheets, parse_columns

    make_sheets(Path(a.views), parse_columns(a.columns), Path(a.out), _csv(a.view), a.score, Path(a.cache) if a.cache else None, Estimators() if a.score else None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
