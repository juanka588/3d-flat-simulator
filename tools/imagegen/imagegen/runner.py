"""Runs one job by spawning the mflux CLI once per image (the way the CG0 spike did). Arguments are always an argv list."""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

from .config import Config
from .jobs import Cancelled, ImageResult, Job
from .models import MODELS
from .validate import JobSpec

TIME_BIN = Path("/usr/bin/time")
_PEAK = re.compile(r"(\d+)\s+peak memory footprint")


def mflux_bin(cfg: Config, name: str) -> str:
    base = cfg.bin_dir or Path(sys.executable).parent
    return str(base / name)


def build_argv(spec: JobSpec, seed: int, output: Path, cfg: Config) -> list[str]:
    """The mflux command for one image. Values are separate list items or `--flag=value`: never a shell string."""
    m = MODELS[spec.model]
    argv = [mflux_bin(cfg, m.cli), "--model", m.mflux_model]
    if m.quantize:
        argv += ["-q", str(m.quantize)]
    argv += [f"--prompt={spec.prompt}", "--steps", str(spec.steps), "--seed", str(seed), "--output", str(output)]
    if spec.negative_prompt:
        argv.append(f"--negative-prompt={spec.negative_prompt}")
    if spec.width and spec.height:
        argv += ["--width", str(spec.width), "--height", str(spec.height)]
    if spec.kind == "generate":
        c = spec.controls[0]
        argv += ["--controlnet-image-path", str(c.path), "--controlnet-strength", repr(c.strength)]
    else:
        assert spec.image is not None
        argv += ["--image-paths", str(spec.image)]
    return argv


def child_env(cfg: Config) -> dict[str, str]:
    env = dict(os.environ)
    env["HF_HOME"] = str(cfg.hf_home)
    if not cfg.allow_download:
        env["HF_HUB_OFFLINE"] = "1"
    return env


def with_peak_memory(argv: list[str]) -> list[str]:
    return [str(TIME_BIN), "-l", *argv] if TIME_BIN.exists() and sys.platform == "darwin" else argv


def parse_peak_gb(stderr: str) -> float | None:
    m = _PEAK.search(stderr)
    return round(int(m.group(1)) / 1e9, 1) if m else None


class MfluxRunner:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def run(self, job: Job) -> None:
        spec = job.spec
        self.cfg.out_dir.mkdir(parents=True, exist_ok=True)
        for i in range(spec.n):
            if job.cancel.is_set():
                raise Cancelled
            seed = spec.seed + i
            out = self.cfg.out_dir / f"{job.id}-s{seed}.png"
            t0 = time.time()
            peak = self._one(job, build_argv(spec, seed, out, self.cfg))
            if not out.is_file():
                raise RuntimeError(f"mflux finished without writing {out.name}")
            job.images.append(ImageResult(str(out), seed, time.time() - t0, peak))
            job.progress = (i + 1) / spec.n

    def _one(self, job: Job, argv: list[str]) -> float | None:
        proc = subprocess.Popen(
            with_peak_memory(argv),
            env=child_env(self.cfg),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            start_new_session=True,
        )

        def kill() -> None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass

        job.kill = kill
        if job.cancel.is_set():
            kill()
        _, err = proc.communicate()
        job.kill = None
        if job.cancel.is_set():
            raise Cancelled
        if proc.returncode != 0:
            tail = "\n".join(err.strip().splitlines()[-12:])
            raise RuntimeError(f"{Path(argv[0]).name} exited with {proc.returncode}: {tail}")
        return parse_peak_gb(err)
