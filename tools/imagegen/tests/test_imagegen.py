"""Request validation, argv building, job queue order and the HTTP guards. No model is loaded: the runner is a fake.

Run: `uv run --directory tools/imagegen python -m unittest discover -s tests -v` (or `pnpm imagegen:test`).
"""

from __future__ import annotations

import base64
import json
import os
import struct
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import zlib
from dataclasses import replace
from pathlib import Path

from imagegen.config import Config
from imagegen.jobs import Cancelled, ImageResult, Job, JobQueue
from imagegen.config import from_env
from imagegen.profiles import PROFILES, SettingsError, estimate_peak_gb, fit_report, pick_profile, resolve_settings
from imagegen.runner import build_argv, parse_peak_gb
from imagegen.server import host_allowed, make_server, origin_allowed, token_ok
from imagegen.validate import ValidationError, parse_edit, parse_generate, validate_size


def png_bytes(w: int = 8, h: int = 8) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\x00" * w for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


os.environ["IMAGEGEN_QUIET"] = "1"


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        self.cfg = Config(hf_home=root / "hf", out_dir=root / "out", in_dir=root / "in", input_roots=(root,), bin_dir=root / "bin")
        self.img = root / "edges.png"
        self.img.write_bytes(png_bytes())

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def gen_body(self, **over: object) -> dict:
        body = {"prompt": "a bathroom", "seed": 7, "n": 2, "width": 1024, "height": 768, "model": "qwen-cn", "controls": [{"type": "canny", "image": str(self.img), "strength": 1.0}]}
        body.update(over)
        return body


class ValidationTests(Base):
    def test_valid_generate(self) -> None:
        s = parse_generate(self.gen_body(), self.cfg)
        self.assertEqual((s.seed, s.n, s.width, s.height, s.steps), (7, 2, 1024, 768, 8))
        self.assertEqual(s.controls[0].path, self.img)

    def test_sizes(self) -> None:
        self.assertEqual(validate_size(512, 384), (512, 384))
        for w, h in [(500, 384), (128, 384), (2048, 768), (1536, 1536), ("512", 384), (True, 384), (512.0, 384)]:
            with self.assertRaises(ValidationError, msg=f"{w}x{h}"):
                validate_size(w, h)  # type: ignore[arg-type]

    def test_rejects_bad_fields(self) -> None:
        bad = [
            {"prompt": ""},
            {"prompt": "x" * 2001},
            {"prompt": "a\x00b"},
            {"prompt": 5},
            {"seed": -1},
            {"seed": 2**32},
            {"seed": 1.5},
            {"n": 0},
            {"n": 5},
            {"steps": 0},
            {"steps": 99},
            {"model": "klein-edit"},
            {"model": "nope"},
            {"height": None},
            {"controls": []},
            {"controls": [{"type": "pose", "image": str(self.img)}]},
            {"controls": [{"type": "canny", "image": str(self.img), "strength": 3}]},
            {"controls": [{"type": "canny", "image": str(self.img), "extra": 1}]},
            {"surprise": 1},
        ]
        for over in bad:
            with self.assertRaises(ValidationError, msg=str(over)):
                parse_generate(self.gen_body(**over), self.cfg)
        with self.assertRaises(ValidationError):
            parse_generate([], self.cfg)

    def test_image_paths_are_confined(self) -> None:
        outside = Path(tempfile.mkdtemp()) / "x.png"
        outside.write_bytes(png_bytes())
        txt = Path(self.tmp.name) / "x.txt"
        txt.write_text("hello")
        fake = Path(self.tmp.name) / "fake.png"
        fake.write_text("not a png")
        for p in [str(outside), str(txt), str(fake), str(Path(self.tmp.name) / "missing.png"), "/etc/passwd", str(Path(self.tmp.name) / ".." / "etc" / "passwd")]:
            with self.assertRaises(ValidationError, msg=p):
                parse_generate(self.gen_body(controls=[{"type": "canny", "image": p, "strength": 1}]), self.cfg)

    def test_base64_image_is_stored(self) -> None:
        b64 = base64.b64encode(png_bytes()).decode()
        for value in (b64, "data:image/png;base64," + b64):
            s = parse_generate(self.gen_body(controls=[{"type": "depth", "image": value, "strength": 0.8}]), self.cfg)
            self.assertTrue(s.controls[0].path.is_file())
            self.assertEqual(s.controls[0].path.parent, self.cfg.in_dir)
        with self.assertRaises(ValidationError):
            parse_generate(self.gen_body(controls=[{"type": "canny", "image": base64.b64encode(b"hello world, not an image").decode()}]), self.cfg)

    def test_edit(self) -> None:
        s = parse_edit({"image": str(self.img), "prompt": "photo", "seed": 1, "strength": 0.4, "model": "klein-edit"}, self.cfg)
        self.assertEqual((s.kind, s.n, s.width, s.strength), ("edit", 1, None, 0.4))
        with self.assertRaises(ValidationError):
            parse_edit({"image": str(self.img), "prompt": "photo", "seed": 1, "model": "qwen-cn"}, self.cfg)
        with self.assertRaises(ValidationError):
            parse_edit({"image": str(self.img), "prompt": "photo", "seed": 1, "model": "klein-edit", "strength": 2}, self.cfg)


class ArgvTests(Base):
    def test_argv_is_a_list_and_injection_proof(self) -> None:
        evil = "x'; rm -rf / #$(touch /tmp/pwn) --seed 9"
        s = parse_generate(self.gen_body(prompt=evil), self.cfg)
        argv = build_argv(s, 8, self.cfg.out_dir / "o.png", self.cfg)
        self.assertIsInstance(argv, list)
        self.assertIn(f"--prompt={evil}", argv)  # one argv item, so it can never become an option
        self.assertEqual(argv.count("--seed"), 1)
        self.assertEqual(argv[argv.index("--seed") + 1], "8")
        self.assertEqual(argv[argv.index("--controlnet-strength") + 1], "1.0")
        self.assertIn("-q", argv)

    def test_edit_argv(self) -> None:
        s = parse_edit({"image": str(self.img), "prompt": "p", "seed": 1, "model": "klein-edit"}, self.cfg)
        argv = build_argv(s, 1, self.cfg.out_dir / "o.png", self.cfg)
        self.assertEqual(argv[argv.index("--image-paths") + 1], str(self.img))
        self.assertNotIn("--width", argv)

    def test_peak_memory(self) -> None:
        self.assertEqual(parse_peak_gb("blah\n  38123456789  peak memory footprint\n"), 38.1)
        self.assertIsNone(parse_peak_gb("nothing"))


class FakeRunner:
    def __init__(self) -> None:
        self.order: list[str] = []
        self.gate = threading.Event()
        self.concurrent = 0
        self.max_concurrent = 0
        self.lock = threading.Lock()

    def run(self, job: Job) -> None:
        with self.lock:
            self.concurrent += 1
            self.max_concurrent = max(self.max_concurrent, self.concurrent)
        try:
            self.order.append(job.spec.prompt)
            while not self.gate.is_set():
                if job.cancel.is_set():
                    raise Cancelled
                time.sleep(0.005)
            if job.spec.prompt == "boom":
                raise RuntimeError("model exploded")
            job.images.append(ImageResult("/x.png", job.spec.seed, 0.1, 1.0))
        finally:
            with self.lock:
                self.concurrent -= 1


def wait_for(cond, timeout: float = 3.0) -> None:  # noqa: ANN001
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return
        time.sleep(0.005)
    raise AssertionError("timed out")


class QueueTests(Base):
    def spec(self, prompt: str):  # noqa: ANN202
        return parse_generate(self.gen_body(prompt=prompt, n=1), self.cfg)

    def test_fifo_one_at_a_time(self) -> None:
        r = FakeRunner()
        q = JobQueue(r)
        jobs = [q.submit(self.spec(f"p{i}")) for i in range(5)]
        wait_for(lambda: jobs[0].status == "running")
        self.assertEqual([j.status for j in jobs[1:]], ["queued"] * 4)
        self.assertEqual(q.get(jobs[3].id)[1], 2)  # position in the queue
        r.gate.set()
        wait_for(lambda: all(j.status == "done" for j in jobs))
        self.assertEqual(r.order, [f"p{i}" for i in range(5)])
        self.assertEqual(r.max_concurrent, 1)
        q.stop()

    def test_cancel_queued_running_and_errors(self) -> None:
        r = FakeRunner()
        q = JobQueue(r)
        a, b, c = q.submit(self.spec("a")), q.submit(self.spec("boom")), q.submit(self.spec("c"))
        wait_for(lambda: a.status == "running")
        q.cancel(b.id)  # queued: dropped without running
        self.assertEqual(b.status, "cancelled")
        q.cancel(a.id)  # running: the runner sees the flag
        wait_for(lambda: a.status == "cancelled")
        r.gate.set()
        wait_for(lambda: c.status == "done")
        self.assertEqual(r.order, ["a", "c"])
        d = q.submit(self.spec("boom"))
        wait_for(lambda: d.status == "error")
        self.assertIn("exploded", d.error or "")
        self.assertIsNone(q.cancel("0" * 16))
        q.stop()


class HttpTests(Base):
    def setUp(self) -> None:
        super().setUp()
        (self.cfg.hf_home / "hub").mkdir(parents=True)
        for repo in ("Qwen--Qwen-Image-2.1-Turbo", "alibaba-pai--Qwen-Image-2.1-Fun-Controlnet-Union"):
            snap = self.cfg.hf_home / "hub" / f"models--{repo}" / "snapshots" / "abc"
            snap.mkdir(parents=True)
            (snap / "w.safetensors").write_bytes(b"x")
        self.runner = FakeRunner()
        self.queue = JobQueue(self.runner)
        self.srv = make_server(replace(self.cfg, port=0), self.queue)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.runner.gate.set()
        self.queue.stop()
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def call(self, method: str, path: str, body: object = None, headers: dict | None = None) -> tuple[int, dict]:
        data = None if body is None else json.dumps(body).encode()
        h = {"Content-Type": "application/json", **(headers or {})}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_health_and_flow(self) -> None:
        st, h = self.call("GET", "/health")
        self.assertEqual(st, 200)
        by_id = {m["id"]: m for m in h["models"]}
        self.assertTrue(by_id["qwen-cn"]["downloaded"])
        self.assertFalse(by_id["klein-edit"]["downloaded"])
        st, r = self.call("POST", "/generate", self.gen_body(n=1))
        self.assertEqual(st, 202)
        self.runner.gate.set()
        wait_for(lambda: self.call("GET", f"/jobs/{r['jobId']}")[1]["status"] == "done")
        st, j = self.call("GET", f"/jobs/{r['jobId']}")
        self.assertEqual(j["images"][0]["seed"], 7)
        self.assertEqual(self.call("DELETE", f"/jobs/{r['jobId']}")[0], 200)
        self.assertEqual(self.call("GET", f"/jobs/{r['jobId']}")[0], 404)

    def test_guards_and_errors(self) -> None:
        self.assertEqual(self.call("GET", "/health", headers={"Host": "evil.example:8790"})[0], 403)
        self.assertEqual(self.call("GET", "/health", headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.call("POST", "/generate", self.gen_body(width=1000))[0], 400)
        self.assertEqual(self.call("POST", "/generate", self.gen_body(), headers={"Content-Type": "text/plain"})[0], 400)
        st, e = self.call("POST", "/edit", {"image": str(self.img), "prompt": "p", "seed": 1, "model": "klein-edit"})
        self.assertEqual((st, e["code"]), (409, "model_missing"))  # not in the cache, downloads off
        self.assertEqual(self.call("GET", "/nope")[0], 404)
        self.assertEqual(self.call("PUT", "/generate", {})[0], 405)

    def test_image_bytes_route(self) -> None:
        self.cfg.out_dir.mkdir(parents=True, exist_ok=True)
        f = self.cfg.out_dir / "x.png"
        f.write_bytes(png_bytes())
        self.runner_images = f
        job = self.queue.submit(parse_generate(self.gen_body(n=1), self.cfg))
        job.images.append(ImageResult(str(f), 7, 0.1, None))
        self.runner.gate.set()
        wait_for(lambda: job.status == "done")
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/jobs/{job.id}/images/1")  # the fake runner appended one more
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/jobs/{job.id}/images/0") as r:
            self.assertEqual((r.status, r.headers["Content-Type"], r.read()[:4]), (200, "image/png", b"\x89PNG"))
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req.full_url.replace("/images/1", "/images/3"))
        self.assertEqual(ctx.exception.code, 404)
        with self.assertRaises(urllib.error.HTTPError) as bad:
            urllib.request.urlopen(f"http://127.0.0.1:{self.port}/jobs/{job.id}/images/0?maxSide=10")
        self.assertIn(bad.exception.code, (400, 501))
        try:
            import PIL  # noqa: F401
        except ImportError:
            return
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/jobs/{job.id}/images/0?maxSide=64") as r:
            self.assertEqual((r.headers["Content-Type"], r.read()[:2]), ("image/jpeg", b"\xff\xd8"))

    def test_host_and_origin_helpers(self) -> None:
        self.assertTrue(all(host_allowed(h) for h in ("127.0.0.1:8790", "localhost", "[::1]:8790", None)))
        self.assertFalse(any(host_allowed(h) for h in ("evil.com", "127.0.0.1.evil.com:80", "10.0.0.5:8790")))
        self.assertTrue(origin_allowed(None, ()))
        self.assertFalse(origin_allowed("http://localhost:5173", ()))
        self.assertTrue(origin_allowed("http://localhost:5173", ("http://localhost:5173",)))


class ConfigAndProfileTests(Base):
    def test_env_and_empty_values(self) -> None:
        c = from_env({"IMAGEGEN_PORT": "9000", "IMAGEGEN_BIND": "", "IMAGEGEN_TOKEN": "", "IMAGEGEN_ALLOWED_HOSTS": "192.168.1.20, nas"})
        self.assertEqual((c.port, c.host, c.token, c.allowed_hosts, c.backend), (9000, "127.0.0.1", None, ("192.168.1.20", "nas"), "mflux"))
        with self.assertRaises(SystemExit):
            from_env({"IMAGEGEN_BACKEND": "cuda"})

    def test_max_side_limits_sizes_and_shrinks_the_default(self) -> None:
        small = replace(self.cfg, max_side=768)
        with self.assertRaises(ValidationError):
            parse_generate(self.gen_body(width=1024, height=768), small)
        s = parse_generate({k: v for k, v in self.gen_body().items() if k not in ("width", "height")}, small)
        self.assertEqual((s.width, s.height), (768, 576))

    def test_profiles(self) -> None:
        self.assertEqual(pick_profile(12.0), "rtx-12gb")  # an RTX 5070 reports ~12 GB
        self.assertEqual([pick_profile(v) for v in (8, 16, 24, 48, 80)], ["rtx-8gb", "rtx-16gb", "rtx-24gb", "rtx-48gb", "rtx-80gb"])
        s = resolve_settings({}, 12.0)
        self.assertEqual((s.profile, s.qwen_precision, s.qwen_offload, s.max_side, s.steps, s.lightning), ("rtx-12gb", "nf4", "sequential", 1024, 8, True))
        o = resolve_settings({"PROFILE": "rtx-24gb", "IMAGEGEN_PRECISION": "fp8", "IMAGEGEN_CPU_OFFLOAD": "false", "IMAGEGEN_MAX_SIDE": "1024", "IMAGEGEN_STEPS": "6"}, 12.0)
        self.assertEqual((o.profile, o.qwen_precision, o.qwen_offload, o.max_side, o.steps), ("rtx-24gb", "fp8", "none", 1024, 6))
        self.assertEqual(resolve_settings({"IMAGEGEN_LIGHTNING": "false"}, 12.0).steps, 30)
        for bad in ({"IMAGEGEN_PRECISION": "fp4"}, {"IMAGEGEN_CPU_OFFLOAD": "maybe"}, {"PROFILE": "rtx-1gb"}, {"IMAGEGEN_STEPS": "x"}, {"IMAGEGEN_MAX_SIDE": "5000"}):
            with self.assertRaises(SettingsError, msg=str(bad)):
                resolve_settings(bad, 12.0)

    def test_every_profile_fits_its_own_card_by_estimate(self) -> None:
        for name, (need, s) in PROFILES.items():
            self.assertEqual(fit_report(s, need + 1.0)["warnings"], [], name)

    def test_health_warns_when_the_profile_is_too_big(self) -> None:
        r = fit_report(PROFILES["rtx-48gb"][1], 12.0)
        self.assertTrue(r["warnings"])
        self.assertFalse(r["qwen-cn"]["fits"])
        self.assertGreater(estimate_peak_gb("qwen-cn", PROFILES["rtx-80gb"][1]), 40)
        self.assertLess(estimate_peak_gb("klein-edit", PROFILES["rtx-12gb"][1]), 11.4)

    def test_token(self) -> None:
        self.assertTrue(token_ok(None, None))
        self.assertTrue(token_ok("Bearer s3cret", "s3cret"))
        self.assertFalse(token_ok(None, "s3cret"))
        self.assertFalse(token_ok("Bearer nope", "s3cret"))
        self.assertFalse(token_ok("s3cret", "s3cret"))
        self.assertTrue(host_allowed("192.168.1.20:8790", ("192.168.1.20",)))
        self.assertFalse(host_allowed("192.168.1.21:8790", ("192.168.1.20",)))


if __name__ == "__main__":
    unittest.main()
