"""Opt-in live check of the real CLIP model (IMAGEGEN_LIVE=1): index about 50 local catalogue photos plus the HD / CC0 thumbnails,
then query crops of the CG0 bathroom reference image and print what comes back.

Needs the `clip` extra, the CLIP weights in the cache (`pnpm imagegen:index --download` once), the local catalogue and a bathroom
image: IMAGEGEN_LIVE_IMAGE (default: .tmp/cg-spike/out/qcn-sdb-french-parisian-s1.png of the main checkout). Skipped otherwise.

    IMAGEGEN_LIVE=1 uv run --directory tools/imagegen --extra clip python -m unittest tests.test_clip_live -v
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from imagegen.config import from_env

LIVE = os.environ.get("IMAGEGEN_LIVE") == "1"
BASE = from_env()
#: In a worktree the gitignored catalogue and the CG0 spike live in the main checkout (.claude/worktrees/<id> -> three levels up).
MAIN = next((p for p in (BASE.catalog_dir.parents[3], Path(__file__).resolve().parents[3].parent.parent.parent) if (p / "apps" / "server" / "local-assets").is_dir()), None)
CATALOG = Path(os.environ["IMAGEGEN_CATALOG_DIR"]) if os.environ.get("IMAGEGEN_CATALOG_DIR") else (MAIN / "apps/server/local-assets/ikea-fr" if MAIN else BASE.catalog_dir)
IMAGE = Path(os.environ.get("IMAGEGEN_LIVE_IMAGE") or (MAIN / ".tmp/cg-spike/out/qcn-sdb-french-parisian-s1.png" if MAIN else "missing"))
#: Boxes in the 1024x768 reference image.
CROPS = {"bathtub": (420, 420, 800, 735), "vanity": (190, 440, 460, 745)}
WANT = re.compile(r"bath|tub|vanity|basin|sink|washbasin|lavabo|baignoire|cabinet|commode|chest|dresser", re.I)


@unittest.skipUnless(LIVE, "set IMAGEGEN_LIVE=1")
@unittest.skipUnless(CATALOG.joinpath("catalog.json").is_file() and IMAGE.is_file(), "needs the local catalogue and the bathroom reference image")
class LiveClipTests(unittest.TestCase):
    def test_bathroom_crops_find_bath_furniture(self) -> None:
        from PIL import Image

        from imagegen.clip import ClipService, prepare_crop

        with tempfile.TemporaryDirectory() as tmp:
            cat = Path(tmp) / "ikea-fr"
            (cat / "photos").mkdir(parents=True)
            entries = json.loads((CATALOG / "catalog.json").read_text("utf8"))["entries"]
            kept = [e for e in entries if (CATALOG / "photos" / f"{e['record']['sku']}.webp").is_file()][:: max(1, len(entries) // 50)][:50]
            for e in kept:
                shutil.copy(CATALOG / "photos" / f"{e['record']['sku']}.webp", cat / "photos")
            (cat / "catalog.json").write_text(json.dumps({"entries": kept}))
            cfg = replace(BASE, catalog_dir=cat, index_dir=Path(tmp) / "index")
            svc = ClipService(cfg, allow_download=False)
            for src in ("catalog", "hd"):
                r = svc.build(src)
                print(f"\nindex {src}: {r['count']} items, {r['seconds']} s, {r['bytes']} bytes")
            im = Image.open(IMAGE)
            found = {}
            for name, box in CROPS.items():
                for bg in ("plain", "border"):
                    q = svc.embed([prepare_crop(im, box, None, bg)], [])["images"][0]
                    top = svc.query(q, 5, ["catalog", "hd"], None, None)["results"]
                    print(f"\n{name} crop ({bg}):")
                    for t in top:
                        print(f"  {t['score']:.3f} {t['kind']:8} {t['id']:42} {t['name'][:50]}")
                    found[(name, bg)] = any(WANT.search(t["name"] + " " + t["id"]) for t in top)
            q = svc.embed([], ["a white bathtub"])["texts"][0]
            print("\ntext 'a white bathtub':")
            top = svc.query(q, 5, ["catalog", "hd"], None, None)["results"]
            for t in top:
                print(f"  {t['score']:.3f} {t['kind']:8} {t['id']:42} {t['name'][:50]}")
            self.assertTrue(any(found.values()), f"no bath/vanity-like item in any top 5: {found}")


if __name__ == "__main__":
    unittest.main()
