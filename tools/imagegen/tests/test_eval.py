"""Coherence evaluation (imagegen.eval): the pure maths on synthetic arrays, the scoring pipeline with fake estimators, the input
blend, the generation argv and the sheets. No model, no download, no GPU. Needs numpy, scipy and Pillow (`pnpm imagegen:test` adds them
with `uv run --with`); skipped without them.
"""

from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

try:
    import numpy as np
    from PIL import Image

    from imagegen.eval import generate as G
    from imagegen.eval import inputs as I
    from imagegen.eval import maths as M
    from imagegen.eval import sheet as S
    from imagegen.eval.models import configure_hf
    from imagegen.eval.score import Reference, score_image
    from imagegen.config import Config

    HAVE = True
except ImportError:  # pragma: no cover
    HAVE = False

W, H = 128, 96


def rect(shape, x0, y0, x1, y1):
    m = np.zeros(shape, bool)
    m[y0:y1, x0:x1] = True
    return m


@unittest.skipUnless(HAVE, "needs numpy, scipy and Pillow")
class MathsTest(unittest.TestCase):
    def test_spearman(self):
        a = np.arange(100.0)
        self.assertAlmostEqual(M.spearman(a, a * 3 + 1), 1.0, places=6)
        self.assertAlmostEqual(M.spearman(a, -a), -1.0, places=6)
        self.assertAlmostEqual(M.spearman(a, a**3), 1.0, places=6)  # rank based: any monotone map
        r = np.random.default_rng(1)
        self.assertLess(abs(M.spearman(r.random(5000), r.random(5000))), 0.06)

    def test_depth_score_clips_and_is_deterministic(self):
        a = np.linspace(0, 1, 300 * 300).reshape(300, 300)
        self.assertAlmostEqual(M.depth_score(a, a), 1.0, places=6)
        self.assertEqual(M.depth_score(a, -a), 0.0)
        r = np.random.default_rng(2).random((300, 300))
        self.assertEqual(M.depth_score(a, r), M.depth_score(a, r))

    def test_gradient_edges_find_a_step(self):
        g = np.zeros((60, 80), np.float32)
        g[:, 40:] = 255
        e = M.gradient_edges(g)
        self.assertTrue(e[:, 38:42].any(axis=1).all())
        self.assertFalse(e[:, :30].any())

    def test_edge_recall_tolerance(self):
        ref = rect((60, 80), 40, 5, 42, 55)
        img = rect((60, 80), 45, 0, 47, 60)  # 5 px away
        self.assertEqual(M.edge_recall(img, ref), 1.0)
        far = rect((60, 80), 70, 0, 72, 60)
        self.assertEqual(M.edge_recall(far, ref), 0.0)
        self.assertEqual(M.edge_recall(img, np.zeros_like(ref)), 0.0)

    def test_palette_masks_and_opening_blobs(self):
        ids = np.zeros((H, W, 3), np.uint8)
        ids[:20] = M.LAYOUT_PALETTE["ceiling"]
        ids[40:70, 10:30] = M.LAYOUT_PALETTE["glass"]
        ids[40:90, 80:100] = M.LAYOUT_PALETTE["door"]
        m = M.palette_masks(ids)
        self.assertEqual(int(m["ceiling"].sum()), 20 * W)
        self.assertEqual(int(m["glass"].sum()), 30 * 20)
        blobs = M.opening_blobs(m["glass"], m["door"])
        self.assertEqual(len(blobs), 2)
        self.assertEqual(sorted(M.bbox(b) for b in blobs), [(10, 40, 29, 69), (80, 40, 99, 89)])

    def test_count_extra_openings(self):
        shape = (H, W)
        expected = [rect(shape, 10, 40, 30, 70)]
        inside = rect(shape, 12, 42, 28, 68)
        self.assertEqual(M.count_extra_openings(inside, expected), 0)
        elsewhere = inside | rect(shape, 80, 10, 110, 40)  # one more window far from ours
        self.assertEqual(M.count_extra_openings(elsewhere, expected), 1)
        tiny = rect(shape, 100, 80, 102, 82)  # below the size threshold and removed by the opening
        self.assertEqual(M.count_extra_openings(tiny, expected), 0)
        self.assertEqual(M.count_extra_openings(inside, []), 1)
        self.assertEqual(M.extra_score(0), 1.0)
        self.assertEqual(M.extra_score(3), 0.25)

    def test_aspect(self):
        self.assertEqual(M.aspect_score(1024, 768), 1.0)
        self.assertEqual(M.aspect_score(1600, 900), 0.0)  # 16:9 is 33 % off 4:3
        self.assertAlmostEqual(M.aspect_score(1050, 768), 1 - 5 * abs(1050 / 768 / (4 / 3) - 1))
        self.assertEqual(M.aspect_score(1600, 900, 16 / 9), 1.0)

    def test_door_ratio(self):
        ceil = np.zeros((400, 100), bool)
        ceil[:50] = True
        door = rect((400, 100), 40, 100, 60, 301)  # rows 100..300
        self.assertAlmostEqual(M.door_ratio(ceil, door), (300 - 49) / 200, places=3)
        self.assertIsNone(M.door_ratio(ceil, np.zeros_like(door)))
        self.assertIsNone(M.door_ratio(np.zeros_like(ceil), door))  # no ceiling visible

    def test_aggregate_and_table(self):
        self.assertEqual(M.aggregate({"depth": 0.5, "edges": 1.0, "extra_n": 7, "score": 9}), 0.75)  # only SCORE_KEYS count
        self.assertEqual(M.aggregate({}), 0.0)
        per = {"v1": {"a": {"score": 0.5, "extra_n": 1, "open_rec": 1.0}, "b": None}, "v2": {"a": {"score": 0.9, "extra_n": 0, "open_rec": 0.5}, "b": {"score": 0.7, "extra_n": 2}}}
        t = M.mean_table(per, ["a", "b"])
        self.assertIn("| v1 | 0.50 | - |", t)
        self.assertIn("| **mean** | 0.70 | 0.70 |", t)
        self.assertIn("| **mean extra openings** | 0.5 | 2.0 |", t)
        self.assertIn("| **mean opening recall** | 0.75 | 0.00 |", t)


class FakeEstimators:
    """Returns what a perfect restyle would: the reference depth, the reference ceiling and windows, every opening recognised."""

    def __init__(self, ref, extra_window=False, wrong_depth=False):
        self.ref, self.extra_window, self.wrong_depth = ref, extra_window, wrong_depth

    def disparity(self, img):
        return -self.ref.depth if self.wrong_depth else self.ref.depth

    def segment(self, img):
        seg = np.zeros(self.ref.depth.shape, np.int64)
        seg[self.ref.ceiling] = M.CEIL
        seg[self.ref.glass] = M.WIN
        if self.extra_window:
            seg[60:90, 100:125] = M.WIN
        return seg

    def opening_recall(self, img, boxes):
        return 1.0 if boxes else None


def synthetic_passes():
    depth = np.tile(np.linspace(255, 0, W, dtype=np.uint8), (H, 1))
    edges = np.full((H, W), 255, np.uint8)
    edges[:, 64] = 0
    edges[20, :] = 0
    ids = np.zeros((H + 30, W, 3), np.uint8)  # 30 rows of legend under the frame
    ids[:20, :] = M.LAYOUT_PALETTE["ceiling"]
    ids[40:70, 10:30] = M.LAYOUT_PALETTE["glass"]
    ids[H:, :] = M.LAYOUT_PALETTE["door"]  # must be cropped away
    return Image.fromarray(depth), Image.fromarray(edges), Image.fromarray(ids)


@unittest.skipUnless(HAVE, "needs numpy, scipy and Pillow")
class ScoreTest(unittest.TestCase):
    def setUp(self):
        d, e, i = synthetic_passes()
        self.ref = Reference.from_images(d, e, i, None, (W, H))
        self.img = Image.fromarray(np.random.default_rng(3).integers(0, 255, (H, W, 3), dtype=np.uint8))

    def test_reference_crops_the_legend(self):
        self.assertEqual(self.ref.door.sum(), 0)
        self.assertEqual(len(self.ref.opens), 1)
        self.assertEqual(self.ref.aspect, 4 / 3)

    def test_perfect_estimators(self):
        r = score_image(self.ref, self.img, FakeEstimators(self.ref))
        self.assertEqual((r["depth"], r["ceiling"], r["open_rec"], r["extra_n"], r["extra"]), (1.0, 1.0, 1.0, 0, 1.0))
        self.assertGreater(r["aspect"], 0.9)  # 128 x 96 is 4:3
        self.assertNotIn("door_h", r)  # no plain door in this view
        self.assertGreater(r["score"], 0.85)

    def test_extra_opening_and_wrong_depth_lower_the_score(self):
        good = score_image(self.ref, self.img, FakeEstimators(self.ref))
        bad = score_image(self.ref, self.img, FakeEstimators(self.ref, extra_window=True, wrong_depth=True))
        self.assertEqual(bad["extra_n"], 1)
        self.assertEqual(bad["extra"], 0.5)
        self.assertEqual(bad["depth"], 0.0)
        self.assertLess(bad["score"], good["score"])

    def test_aspect_follows_the_render(self):
        d, e, i = synthetic_passes()
        wide = Image.new("RGB", (1600, 900))
        ref = Reference.from_images(d, e, i, wide, (W, H))
        r = score_image(ref, Image.new("RGB", (160, 90)), FakeEstimators(ref))
        self.assertEqual(r["aspect"], 1.0)

    def test_reference_load_from_files(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as t:
            d, e, i = synthetic_passes()
            for n, im in (("depth", d), ("edges", e), ("ids", i)):
                im.save(Path(t) / f"{n}.png")
            ref = Reference.load(Path(t) / "depth.png", Path(t) / "edges.png", Path(t) / "ids.png")
            self.assertEqual(ref.size, (1024, 768))
            self.assertEqual(len(ref.opens), 1)


@unittest.skipUnless(HAVE, "needs numpy, scipy and Pillow")
class InputsAndGenerateTest(unittest.TestCase):
    def make_views(self, root: Path):
        d, e, i = synthetic_passes()
        v = root / "1-room"
        v.mkdir(parents=True)
        Image.new("RGB", (W, H), (120, 100, 80)).save(v / "render.png")
        d.save(v / "depth.png")
        e.save(v / "edges.png")
        i.save(v / "ids.png")
        (root / "broken").mkdir()
        return v

    def test_control_blend(self):
        depth = np.tile(np.linspace(0, 255, 100, dtype=np.uint8), (50, 1))
        edges = np.full((50, 100), 255, np.uint8)
        edges[:, 50] = 0
        c = I.control_blend(depth, edges)
        self.assertEqual(c.dtype, np.uint8)
        self.assertTrue((c[:, 50:52] == 255).all())  # edges drawn 2 px wide, white
        self.assertLessEqual(int(c[:, :49].max()), int(255 * 0.55))  # depth at 55 % brightness
        self.assertLess(c[0, 5], c[0, 45])  # near = bright

    def test_make_inputs_and_generate_argv(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as t:
            t = Path(t)
            self.make_views(t / "views")
            with redirect_stdout(io.StringIO()):
                done = I.make_inputs(t / "views", t / "in", size=(64, 48))
            self.assertEqual(done, ["1-room"])  # `broken` has no passes: skipped
            vd = t / "in" / "1-room"
            for n in ("base", "depth", "edges", "control"):
                self.assertEqual(Image.open(vd / f"{n}.png").size, (64, 48))
            with self.assertRaises(G.MissingInput):
                G.build("qwen-cn", vd, 1, t / "o.png", Config())  # no prompt yet
            (vd / "prompt.txt").write_text("A bright living room.")
            (vd / "negative.txt").write_text("people")
            cfg = Config(bin_dir=Path("/bin-dir"))
            cn = G.build("qwen-cn", vd, 3205, t / "o.png", cfg)
            self.assertEqual(cn[0], "/bin-dir/mflux-generate-qwen-2.1-controlnet")
            self.assertIn("--prompt=A bright living room.", cn)
            self.assertIn("--negative-prompt=people", cn)
            self.assertEqual(cn[cn.index("--controlnet-strength") + 1], "0.8")
            self.assertEqual(cn[cn.index("--controlnet-image-path") + 1], str(vd / "control.png"))
            self.assertEqual(cn[cn.index("--seed") + 1], "3205")
            ed = G.build("qwen21-edit", vd, 7, t / "o.png", cfg)
            self.assertEqual(ed[0], "/bin-dir/mflux-generate-qwen-2.1-edit")
            i = ed.index("--image-paths")
            self.assertEqual([Path(p).name for p in ed[i + 1 : i + 4]], ["base.png", "edges.png", "depth.png"])
            kl = G.build("klein", vd, 7, t / "o.png", cfg)
            self.assertEqual(kl[0], "/bin-dir/mflux-generate-flux2-edit")
            self.assertEqual(kl[kl.index("--image-paths") + 1], str(vd / "base.png"))
            (vd / "prompt-klein.txt").write_text("klein only")
            self.assertIn("--prompt=klein only", G.build("klein", vd, 7, t / "o.png", cfg))
            with redirect_stdout(io.StringIO()) as out:
                self.assertEqual(G.run("qwen-cn", t / "in", t / "out", [1, 2], views=["1-room"], cfg=cfg, dry=True), 0)
            self.assertEqual(out.getvalue().count("mflux-generate-qwen-2.1-controlnet"), 2)
            self.assertFalse((t / "out" / "log.txt").exists())

    def test_configure_hf_is_offline_unless_download(self):
        keep = {k: os.environ.get(k) for k in ("HF_HOME", "HF_HUB_OFFLINE")}
        try:
            configure_hf(False, {"IMAGEGEN_HF_HOME": "/x/hf"})
            self.assertEqual((os.environ["HF_HOME"], os.environ["HF_HUB_OFFLINE"]), ("/x/hf", "1"))
            configure_hf(True, {"IMAGEGEN_HF_HOME": "/x/hf"})
            self.assertNotIn("HF_HUB_OFFLINE", os.environ)
        finally:
            for k, v in keep.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)


@unittest.skipUnless(HAVE, "needs numpy, scipy and Pillow")
class SheetTest(unittest.TestCase):
    def test_columns_and_sheets(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as t:
            t = Path(t)
            v = t / "views" / "kitchen"
            v.mkdir(parents=True)
            Image.new("RGB", (64, 48), "white").save(v / "render.png")
            Image.new("L", (64, 48), 255).save(v / "edges.png")
            a = t / "a"
            a.mkdir()
            for n in ("kitchen-s1.png", "kitchen-s2.png", "other-s1.png"):
                Image.new("RGB", (64, 48), "blue").save(a / n)
            self.assertEqual(S.parse_columns("x=/p/a, y=/p/b"), [("x", Path("/p/a")), ("y", Path("/p/b"))])
            with self.assertRaises(SystemExit):
                S.parse_columns("nodir")
            self.assertEqual([s for s, _ in S.find_images(a, "kitchen")], ["s1", "s2"])
            labels = [n for n, _ in S.view_columns(t / "views", "kitchen", [("m", a)])]
            self.assertEqual(labels, ["our render", "edges", "m s1", "m s2"])
            with redirect_stdout(io.StringIO()):
                S.make_sheets(t / "views", [("m", a)], t / "sheets")
                S.make_sheets(t / "views", [("m", a)], t / "one.jpg", only=["kitchen"])
            self.assertEqual(Image.open(t / "sheets" / "kitchen.jpg").size, (S.CW * 4, S.CH + 90))
            self.assertTrue((t / "one.jpg").is_file())


if __name__ == "__main__":
    unittest.main()
