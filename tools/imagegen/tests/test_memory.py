"""Memory handling of the sidecar: unload option, one resident model, timings, memory facts. No model, no GPU.

Run with the rest: `pnpm imagegen:test`.
"""

from __future__ import annotations

import os
import threading
import time
import unittest
from dataclasses import replace

import test_imagegen as base
from imagegen.config import from_env, parse_unload_after
from imagegen.diffusers_backend import DiffusersRunner
from imagegen.jobs import Cancelled, ImageResult, Job, JobQueue
from imagegen.memstat import headroom_warning, parse_swapusage, parse_vm_stat
from imagegen.profiles import resolve_settings
from imagegen.runner import build_argv, parse_steps
from imagegen.server import health, unload_policy

os.environ["IMAGEGEN_QUIET"] = "1"

VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  2051613.
Pages active:                                 803450.
Pages inactive:                               694458.
Pages speculative:                            114959.
Pages wired down:                             222061.
Pages purgeable:                               46512.
Pages occupied by compressor:                 246856.
"""


class ResidentRunner:
    """Holds a 'model' between jobs like the diffusers runner does."""

    def __init__(self) -> None:
        self.model: str | None = None
        self.unloads = 0
        self.runs = 0

    def resident(self) -> str | None:
        return self.model

    def unload(self) -> None:
        self.model = None
        self.unloads += 1

    def run(self, job: Job) -> None:
        self.runs += 1
        self.model = job.spec.model
        time.sleep(0.02)
        job.images.append(ImageResult("/x.png", job.spec.seed, 0.5, 1.0, 0.2, 0.3))


class MemstatTests(unittest.TestCase):
    def test_vm_stat_and_swap(self) -> None:
        vm = parse_vm_stat(VM_STAT)
        self.assertAlmostEqual(vm["free"], 2051613 * 16384 / 1e9, places=3)
        self.assertAlmostEqual(vm["inactive"], 694458 * 16384 / 1e9, places=3)
        sw = parse_swapusage("total = 12288.00M  used = 10588.50M  free = 1699.50M  (encrypted)")
        self.assertAlmostEqual(sw["used"], 10.5885, places=3)
        self.assertAlmostEqual(parse_swapusage("total = 2.50G  used = 1.00G  free = 1.50G")["total"], 2.5)

    def test_headroom_warning(self) -> None:
        self.assertIn("swap", headroom_warning({"availableGb": 20, "swapUsedGb": 10.6, "pressure": "warn"}, 38) or "")
        self.assertIn("pressure is critical", headroom_warning({"availableGb": 60, "swapUsedGb": 0, "pressure": "critical"}, 38) or "")
        self.assertIsNone(headroom_warning({"availableGb": 60, "swapUsedGb": 9, "pressure": "normal"}, 38))
        self.assertIsNone(headroom_warning({}, 38))


class ConfigTests(base.Base):
    def test_unload_after_parsing(self) -> None:
        self.assertIsNone(parse_unload_after(None))
        self.assertIsNone(parse_unload_after("never"))
        self.assertEqual(parse_unload_after("job"), 0.0)
        self.assertEqual(parse_unload_after("0"), 0.0)
        self.assertEqual(parse_unload_after("300"), 300.0)
        with self.assertRaises(SystemExit):
            parse_unload_after("soon")
        with self.assertRaises(SystemExit):
            parse_unload_after("-5")
        self.assertEqual(from_env({"IMAGEGEN_UNLOAD_AFTER": "120"}).unload_after, 120.0)
        self.assertIsNone(from_env({"IMAGEGEN_UNLOAD_AFTER": ""}).unload_after)

    def test_policy_text(self) -> None:
        self.assertIn("one process per image", unload_policy(replace(self.cfg, backend="mflux")))
        self.assertEqual(unload_policy(replace(self.cfg, backend="diffusers", unload_after=0)), "after each job")
        self.assertEqual(unload_policy(replace(self.cfg, backend="diffusers", unload_after=90)), "after 90 s idle")

    def test_mflux_memory_flags(self) -> None:
        spec = base.parse_generate(self.gen_body(), self.cfg)
        plain = build_argv(spec, 1, self.cfg.out_dir / "a.png", self.cfg)
        self.assertNotIn("--low-ram", plain)
        argv = build_argv(spec, 1, self.cfg.out_dir / "a.png", replace(self.cfg, low_ram=True, mlx_cache_gb=8))
        self.assertIn("--low-ram", argv)
        self.assertEqual(argv[argv.index("--mlx-cache-limit-gb") + 1], "8")

    def test_parse_steps(self) -> None:
        err = "loading\n  0%|          | 0/8 [00:00<?, ?it/s]\n 50%|█████     | 4/8 [00:31<00:31,  7.8s/it]\n100%|██████████| 8/8 [01:02<00:00,  7.8s/it]\n"
        self.assertEqual(parse_steps(err), (8, 8, 62))
        self.assertEqual(parse_steps("1/2 [1:01:05<00:10"), (1, 2, 3665))
        self.assertIsNone(parse_steps("no progress"))


class UnloadTests(base.Base):
    def spec(self, prompt: str = "p", model: str = "qwen-cn"):  # noqa: ANN202
        return base.parse_generate(self.gen_body(prompt=prompt, n=1), self.cfg) if model == "qwen-cn" else base.parse_edit({"image": str(self.img), "prompt": prompt, "seed": 1, "strength": 0.5, "model": "klein-edit"}, self.cfg)

    def run_jobs(self, queue: JobQueue, n: int = 1) -> list[Job]:
        jobs = [queue.submit(self.spec(f"p{i}")) for i in range(n)]
        base.wait_for(lambda: all(j.status == "done" for j in jobs))
        return jobs

    def test_never_by_default(self) -> None:
        r = ResidentRunner()
        q = JobQueue(r)
        self.run_jobs(q)
        time.sleep(0.15)
        self.assertEqual((r.model, r.unloads), ("qwen-cn", 0))
        q.stop()

    def test_after_each_job_but_not_between_queued_jobs(self) -> None:
        r = ResidentRunner()
        q = JobQueue(r, 0)
        self.run_jobs(q, 3)
        base.wait_for(lambda: r.model is None)
        self.assertEqual(r.runs, 3)
        self.assertLessEqual(r.unloads, 2)  # back-to-back jobs keep the model; at least the last one frees it
        self.assertGreaterEqual(r.unloads, 1)
        q.stop()

    def test_after_idle_seconds(self) -> None:
        r = ResidentRunner()
        q = JobQueue(r, 0.2)
        self.run_jobs(q)
        self.assertEqual(r.model, "qwen-cn")
        base.wait_for(lambda: r.model is None, 3.0)
        self.assertEqual(r.unloads, 1)
        # and the next job loads again
        self.run_jobs(q)
        self.assertEqual(r.runs, 2)
        q.stop()

    def test_idle_timer_restarts_after_a_job(self) -> None:
        r = ResidentRunner()
        q = JobQueue(r, 0.4)
        self.run_jobs(q)
        time.sleep(0.2)
        self.run_jobs(q)  # arrives before the first idle period ran out: the clock restarts
        time.sleep(0.25)
        self.assertEqual(r.model, "qwen-cn")
        base.wait_for(lambda: r.model is None, 3.0)
        q.stop()

    def test_timings_and_last_job(self) -> None:
        r = ResidentRunner()
        q = JobQueue(r)
        (job,) = self.run_jobs(q)
        j = job.to_json()
        self.assertEqual((j["images"][0]["loadS"], j["images"][0]["stepsS"]), (0.2, 0.3))
        self.assertIn("runS", j["timings"])
        self.assertEqual(j["timings"]["loadS"], 0.2)
        base.wait_for(lambda: q.last_job is not None)
        self.assertEqual(q.last_job["status"], "done")
        h = health(self.cfg, q, mem={"availableGb": 40.0, "swapUsedGb": 0.0, "pressure": "normal"})
        self.assertEqual(h["lastJob"]["jobId"], job.id)
        self.assertEqual(h["memory"]["availableGb"], 40.0)
        self.assertEqual(h["resident"], {"models": ["qwen-cn"], "estGb": 38.0, "holdsBetweenJobs": True})
        self.assertIn("never", h["unload"])
        q.stop()

    def test_health_when_nothing_is_loaded(self) -> None:
        q = JobQueue(base.FakeRunner())
        h = health(self.cfg, q, mem={})
        self.assertEqual(h["resident"], {"models": [], "estGb": 0.0, "holdsBetweenJobs": False})
        q.stop()


class DiffusersResidencyTests(base.Base):
    """klein-edit and qwen-cn are never resident together: the first is released before the second loads."""

    def test_models_swap_one_at_a_time(self) -> None:
        settings = resolve_settings({}, 24.0)
        runner = DiffusersRunner(self.cfg, settings, log=lambda m: None)
        seen: list[tuple[str, str | None]] = []
        runner._load_qwen = lambda: (seen.append(("qwen-cn", runner.resident())), object())[1]  # type: ignore[method-assign]
        runner._load_klein = lambda: (seen.append(("klein-edit", runner.resident())), object())[1]  # type: ignore[method-assign]
        runner._get("qwen-cn")
        self.assertEqual(runner.resident(), "qwen-cn")
        runner._get("qwen-cn")  # reused, not reloaded
        runner._get("klein-edit")
        self.assertEqual(runner.resident(), "klein-edit")
        self.assertEqual(seen, [("qwen-cn", None), ("klein-edit", None)])  # nothing was resident while either loaded
        runner.unload()
        self.assertIsNone(runner.resident())
        self.assertIsNone(runner._pipe)


if __name__ == "__main__":
    unittest.main()
