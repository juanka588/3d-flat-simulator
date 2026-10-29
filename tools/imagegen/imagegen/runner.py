"""Runs one job by spawning the mflux CLI once per image (the way the CG0 spike did). Arguments are always an argv list."""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .config import Config
from .jobs import Cancelled, ImageResult, Job
from .memstat import headroom_warning, read_memory
from .models import MODELS
from .validate import JobSpec

TIME_BIN = Path("/usr/bin/time")
_PEAK = re.compile(r"(\d+)\s+peak memory footprint")
#: tqdm progress of the denoising loop: `3/8 [00:24<00:40, 8.1s/it]`; `0/8 [00:00<?, ?it/s]` is printed when the loop starts.
_STEP = re.compile(r"(\d+)/(\d+) \[(?:(\d+):)?(\d+):(\d+)<")


def mflux_bin(cfg: Config, name: str) -> str:
    base = cfg.bin_dir or Path(sys.executable).parent
    return str(base / name)


def build_argv(spec: JobSpec, seed: int, output: Path, cfg: Config) -> list[str]:
    """The mflux command for one image. Values are separate list items or `--flag=value`: never a shell string."""
    m = MODELS[spec.model]
    argv = [mflux_bin(cfg, m.cli), "--model", m.mflux_model]
    if m.quantize:
        argv += ["-q", str(m.quantize)]
    if cfg.low_ram:
        argv.append("--low-ram")
    if cfg.mlx_cache_gb:
        argv += ["--mlx-cache-limit-gb", f"{cfg.mlx_cache_gb:g}"]
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


def parse_steps(stderr: str) -> tuple[int, int, float] | None:
    """The last tqdm progress of the denoising loop in `stderr`: (done, total, elapsed seconds), or None."""
    last = None
    for m in _STEP.finditer(stderr):
        h, mi, se = m.group(3), int(m.group(4)), int(m.group(5))
        last = (int(m.group(1)), int(m.group(2)), (int(h) * 3600 if h else 0) + mi * 60 + se)
    return last


@dataclass
class OneRun:
    peak_gb: float | None
    #: Seconds from the start of the process to the first denoising step (model load + text encoding).
    load_s: float | None
    #: Seconds of the denoising steps (tqdm's own elapsed time when it printed one).
    steps_s: float | None


class _Stderr:
    """Reads the child's stderr as it arrives (tqdm writes `\r`-separated updates) to time the moment the denoising loop starts."""

    TAIL = 60_000

    def __init__(self, stream, t0: float) -> None:  # noqa: ANN001
        self.t0 = t0
        self.first_step_at: float | None = None
        self.text = ""
        self._stream = stream
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()

    def _read(self) -> None:
        fd = self._stream.fileno()
        while True:
            try:
                data = os.read(fd, 4096)  # returns what is there: a buffered text read would hold the first progress line back
            except OSError:
                return
            if not data:
                return
            self.text = (self.text + data.decode("utf-8", "replace").replace("\r", "\n"))[-self.TAIL :]
            if self.first_step_at is None and _STEP.search(self.text):
                self.first_step_at = time.time()

    def finish(self) -> str:
        self._thread.join(timeout=5)
        return self.text


class MfluxRunner:
    """One `mflux-*` process per image. The process exits after the image, so no model stays resident between images (or jobs):
    `IMAGEGEN_UNLOAD_AFTER` has nothing to free here, and klein-edit and qwen-cn can never be in memory together (one process at a time).
    The price is a model load per image; `loadS` / `stepsS` in the job result say how much."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def resident(self) -> str | None:
        return None

    def unload(self) -> None:
        return None

    def run(self, job: Job) -> None:
        spec = job.spec
        self.cfg.out_dir.mkdir(parents=True, exist_ok=True)
        for i in range(spec.n):
            if job.cancel.is_set():
                raise Cancelled
            seed = spec.seed + i
            out = self.cfg.out_dir / f"{job.id}-s{seed}.png"
            warn = headroom_warning(read_memory(), MODELS[spec.model].peak_gb)
            if warn and warn not in job.warnings:
                job.warnings.append(warn)
                os.write(2, f"[imagegen] WARNING job {job.id}: {warn}\n".encode())
            t0 = time.time()
            run = self._one(job, build_argv(spec, seed, out, self.cfg))
            if not out.is_file():
                raise RuntimeError(f"mflux finished without writing {out.name}")
            wall = time.time() - t0
            job.images.append(ImageResult(str(out), seed, wall, run.peak_gb, run.load_s, run.steps_s))
            job.progress = (i + 1) / spec.n

    def _one(self, job: Job, argv: list[str]) -> OneRun:
        t0 = time.time()
        proc = subprocess.Popen(
            with_peak_memory(argv),
            env=child_env(self.cfg),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        watch = _Stderr(proc.stderr, t0)

        def kill() -> None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass

        job.kill = kill
        if job.cancel.is_set():
            kill()
        proc.wait()
        err = watch.finish()
        job.kill = None
        if job.cancel.is_set():
            raise Cancelled
        if proc.returncode != 0:
            tail = "\n".join([ln for ln in err.strip().splitlines() if not _STEP.search(ln)][-12:])
            raise RuntimeError(f"{Path(argv[0]).name} exited with {proc.returncode}: {tail}")
        steps = parse_steps(err)
        load = watch.first_step_at - t0 if watch.first_step_at else None
        stepped = steps[2] if steps and steps[0] == steps[1] else None
        return OneRun(parse_peak_gb(err), load, stepped)
