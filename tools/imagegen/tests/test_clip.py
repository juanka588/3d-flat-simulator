"""CG3 similarity index: build and query on 5 fixture images with a deterministic fake embedder (no torch, no model).

Needs Pillow (`pnpm imagegen:test` adds it with `uv run --with pillow`); skipped without it.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from dataclasses import replace
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

from imagegen.clip import ClipError, ClipService, Item, prepare_crop, read_index, write_index
from imagegen.config import Config
from imagegen.jobs import JobQueue
from imagegen.server import make_server

os.environ["IMAGEGEN_QUIET"] = "1"

COLOURS = {"red": (220, 30, 30), "green": (30, 200, 40), "blue": (30, 40, 220), "yellow": (230, 220, 30), "black": (10, 10, 10)}


class FakeEmbedder:
    """Image -> mean colour (3 dims) padded with a constant; text -> colour name lookup. Deterministic and semantic enough."""

    name = "fake/colour"
    dim = 4

    def embed_images(self, images):
        out = []
        for im in images:
            s = im.convert("RGB").resize((1, 1), Image.BOX).getpixel((0, 0))
            # the white padding of prepare_crop dilutes the mean: use the darkest-channel-weighted pixel of the centre instead
            c = im.convert("RGB").getpixel((im.width // 2, im.height // 2))
            out.append([c[0] / 255, c[1] / 255, c[2] / 255, 0.1] if s else [0, 0, 0, 0.1])
        return out

    def embed_texts(self, texts):
        return [[*(v / 255 for v in COLOURS.get(t.split()[0], (128, 128, 128))), 0.1] for t in texts]


@unittest.skipIf(Image is None, "Pillow not installed")
class ClipIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        cat = root / "ikea-fr"
        (cat / "photos").mkdir(parents=True)
        entries = []
        for i, (name, rgb) in enumerate(COLOURS.items()):
            sku = f"0000000{i}"
            Image.new("RGB", (64, 64), rgb).save(cat / "photos" / f"{sku}.webp")
            entries.append({"has3d": i % 2 == 0, "record": {"provider": "ikea-fr", "sku": sku, "name": f"{name} thing", "price": 10 * (i + 1), "currency": "EUR", "category": "sofa" if i < 3 else "table", "dims": {"w": 1, "d": 1, "h": 1}}})
        (cat / "catalog.json").write_text(json.dumps({"entries": entries}))
        hd = root / "models"
        (hd / "thumbs").mkdir(parents=True)
        Image.new("RGBA", (32, 32), (220, 30, 30, 255)).save(hd / "thumbs" / "r.webp")
        (hd / "catalog.json").write_text(json.dumps([{"id": "cc0:red_chair", "name": "Red chair", "category": "chair", "nativeDims": {"w": 1, "d": 1, "h": 1}, "thumb": "thumbs/r.webp"}]))
        self.cfg = Config(hf_home=root / "hf", out_dir=root / "out", in_dir=root / "in", input_roots=(root,), catalog_dir=cat, hd_dirs=(hd,), index_dir=root / "index")
        self.svc = ClipService(self.cfg, FakeEmbedder())
        self.root = root

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_build_roundtrip_and_files(self) -> None:
        r = self.svc.build("catalog")
        self.assertEqual(r["count"], 5)
        self.assertTrue((self.cfg.catalog_dir / "clip-index.json").is_file())
        self.assertTrue((self.cfg.catalog_dir / "clip-index.bin").is_file())
        idx = read_index(self.cfg.catalog_dir / "clip-index.json", self.cfg.catalog_dir / "clip-index.bin", "catalog")
        self.assertEqual(len(idx.items), 5)
        for i in range(5):  # rows are unit length
            self.assertAlmostEqual(math.sqrt(sum(idx.vectors[i * 4 + j] ** 2 for j in range(4))), 1.0, places=5)
        self.assertEqual(self.svc.build("hd")["count"], 1)
        self.assertTrue((self.cfg.index_dir / "hd-clip-index.json").is_file())

    def test_query_by_image_crop_and_text(self) -> None:
        self.svc.build("catalog")
        self.svc.build("hd")
        scene = Image.new("RGB", (200, 100), (200, 200, 200))
        scene.paste(Image.new("RGB", (40, 40), COLOURS["blue"]), (100, 30))
        crop = prepare_crop(scene, (95, 25, 150, 80))
        q = self.svc.embed([crop], [])["images"][0]
        top = self.svc.query(q, 3, ["catalog", "hd"], None, None)["results"]
        self.assertEqual(top[0]["id"], "ikea-fr:00000002")
        self.assertEqual(top[0]["kind"], "product")
        t = self.svc.embed([], ["red sofa"])["texts"][0]
        best = self.svc.query(t, 2, ["catalog", "hd"], None, None)["results"]
        self.assertEqual({r["id"] for r in best}, {"ikea-fr:00000000", "cc0:red_chair"})  # same colour: a product and a library asset

    def test_filters(self) -> None:
        self.svc.build("catalog")
        q = self.svc.embed([], ["red x"])["texts"][0]
        self.assertTrue(all(r["category"] == "table" for r in self.svc.query(q, 5, ["catalog"], "table", None)["results"]))
        cheap = self.svc.query(q, 5, ["catalog"], None, 20)["results"]
        self.assertEqual({r["id"] for r in cheap}, {"ikea-fr:00000000", "ikea-fr:00000001"})

    def test_missing_and_stale_index(self) -> None:
        with self.assertRaises(ClipError) as e:
            self.svc.query([1, 0, 0, 0], 3, ["catalog"], None, None)
        self.assertEqual(e.exception.code, "index_missing")
        self.svc.build("catalog")
        class Other(FakeEmbedder):
            name = "other"
        with self.assertRaises(ClipError) as e2:
            ClipService(self.cfg, Other()).query([1, 0, 0, 0], 3, ["catalog"], None, None)
        self.assertEqual(e2.exception.code, "index_stale")

    def test_mask_beats_clutter(self) -> None:
        scene = Image.new("RGB", (100, 100), (200, 200, 200))
        scene.paste(Image.new("RGB", (30, 30), COLOURS["red"]), (35, 35))
        ids = Image.new("RGB", (100, 100), (0, 0, 0))
        ids.paste(Image.new("RGB", (30, 30), (7, 9, 11)), (35, 35))
        from imagegen.clip import mask_from_ids

        m = mask_from_ids(ids, (7, 9, 11))
        self.assertEqual(m.getpixel((50, 50)), 255)
        self.assertEqual(m.getpixel((5, 5)), 0)
        out = prepare_crop(scene, None, m)
        self.assertEqual(out.getpixel((2, 2)), (255, 255, 255))
        self.assertEqual(out.getpixel((out.width // 2, out.height // 2)), COLOURS["red"])

    def test_http_routes(self) -> None:
        srv = make_server(replace(self.cfg, port=0), JobQueue(_NoRunner()), None, self.svc)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        def call(path: str, body: dict) -> tuple[int, dict]:
            req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())

        try:
            self.assertEqual(call("/index/query", {"text": "red x"})[1]["code"], "index_missing")
            st, b = call("/index/build", {"source": "catalog"})
            self.assertEqual((st, b["count"]), (200, 5))
            st, q = call("/index/query", {"text": "green x", "topK": 1, "source": "catalog"})
            self.assertEqual(q["results"][0]["id"], "ikea-fr:00000001")
            self.assertEqual(call("/index/query", {"topK": 3})[0], 400)
            self.assertEqual(call("/index/query", {"text": "a", "topK": 99})[0], 400)
            self.assertEqual(call("/index/build", {"source": "nope"})[0], 400)
            self.assertEqual(call("/index/query", {"image": "/etc/passwd", "box": [0, 0, 9, 9]})[0], 400)
            st, e = call("/embed", {"texts": ["blue x"]})
            self.assertEqual((st, e["dim"], len(e["texts"][0])), (200, 4, 4))
        finally:
            srv.shutdown()
            srv.server_close()


class _NoRunner:
    def run(self, job) -> None:  # pragma: no cover
        raise AssertionError("no job expected")


if __name__ == "__main__":
    unittest.main()
