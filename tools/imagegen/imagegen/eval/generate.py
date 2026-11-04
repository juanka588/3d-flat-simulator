"""Generation drivers of the restyle spike: the same mflux commands as the sidecar, one process per image, with a memory guard.

  qwen-cn      Qwen-Image-2.1-Turbo + Fun-Controlnet-Union: control.png (depth + edges blend) at strength 0.8, 8 steps (sidecar `qwen-cn`)
  qwen21-edit  Qwen-Image-2.1-Turbo edit: base.png + edges.png + depth.png as three source images, 8 steps (not a sidecar model)
  klein        FLUX.2-klein-4B edit: base.png only, 4 steps (sidecar `klein-edit`)

Inputs per view (see inputs.py): <inputs>/<view>/{base,edges,depth,control}.png, prompt.txt (or prompt-<method>.txt), negative.txt (optional).
Outputs: <out>/<view>-s<seed>.png (existing files are kept, so a run resumes) and <out>/log.txt.
"""

from __future__ import annotations

import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path

from ..config import Config, from_env
from ..memstat import headroom_warning, read_memory
from ..models import MODELS
from ..runner import build_argv, child_env, mflux_bin, parse_peak_gb, with_peak_memory
from ..validate import Control, JobSpec
from .inputs import list_views

METHODS = ("qwen-cn", "qwen21-edit", "klein")
QWEN_CN_STRENGTH = 0.8
#: Peak memory (GB, M4 Max, mflux) used for the headroom guard.
PEAK_GB = {"qwen-cn": MODELS["qwen-cn"].peak_gb, "klein": MODELS["klein-edit"].peak_gb, "qwen21-edit": 38.0}


class MissingInput(Exception):
    pass


def read_text(vd: Path, names: list[str], required: bool) -> str | None:
    for n in names:
        if (vd / n).is_file():
            return (vd / n).read_text().strip()
    if required:
        raise MissingInput(f"{vd}: none of {', '.join(names)}")
    return None


def need(vd: Path, name: str) -> Path:
    if not (vd / name).is_file():
        raise MissingInput(f"{vd / name} missing (run `inputs` first)")
    return vd / name


def build(method: str, vd: Path, seed: int, out: Path, cfg: Config, width: int = 1024, height: int = 768, steps: int | None = None) -> list[str]:
    """The mflux argv for one image of one view."""
    prompt = read_text(vd, [f"prompt-{method}.txt", "prompt.txt"], True)
    assert prompt is not None
    if method == "qwen-cn":
        spec = JobSpec("generate", "qwen-cn", prompt, read_text(vd, ["negative.txt"], False), seed, 1, width, height, steps or MODELS["qwen-cn"].default_steps,
                       controls=(Control("blend", need(vd, "control.png"), QWEN_CN_STRENGTH),))
        return build_argv(spec, seed, out, cfg)
    if method == "klein":
        spec = JobSpec("edit", "klein-edit", prompt, None, seed, 1, width, height, steps or MODELS["klein-edit"].default_steps, image=need(vd, "base.png"))
        return build_argv(spec, seed, out, cfg)
    if method == "qwen21-edit":
        argv = [mflux_bin(cfg, "mflux-generate-qwen-2.1-edit"), "--model", "qwen-image-2.1-turbo", "-q", "8"]
        if cfg.low_ram:
            argv.append("--low-ram")
        return argv + ["--image-paths", str(need(vd, "base.png")), str(need(vd, "edges.png")), str(need(vd, "depth.png")),
                       f"--prompt={prompt}", "--steps", str(steps or 8), "--seed", str(seed), "--width", str(width), "--height", str(height), "--output", str(out)]
    raise SystemExit(f"unknown method {method!r}: one of {', '.join(METHODS)}")


def run(method: str, inputs: Path, out: Path, seeds: list[int], views: list[str] | None = None, cfg: Config | None = None, download: bool = False,
        dry: bool = False, force: bool = False, steps: int | None = None, size: tuple[int, int] = (1024, 768)) -> int:
    cfg = replace(cfg or from_env(), allow_download=download)
    out.mkdir(parents=True, exist_ok=True)
    log = out / "log.txt"
    for seed in seeds:
        for v in list_views(inputs, views):
            target = out / f"{v}-s{seed}.png"
            if target.exists() and not dry:
                continue
            argv = build(method, inputs / v, seed, target, cfg, size[0], size[1], steps)
            if dry:
                print(" ".join(argv))
                continue
            warn = headroom_warning(read_memory(), PEAK_GB[method])
            for _ in range(9 if warn else 0):  # give other jobs 90 s to release memory
                time.sleep(10)
                warn = headroom_warning(read_memory(), PEAK_GB[method])
                if not warn:
                    break
            if warn and not force:
                print(f"ABORT before {v} s{seed}: {warn} (--force to run anyway)", file=sys.stderr)
                return 3
            t0 = time.time()
            p = subprocess.run(with_peak_memory(argv), env=child_env(cfg), stdin=subprocess.DEVNULL, capture_output=True, text=True)
            line = f"{v} s{seed} {method} rc={p.returncode} secs={time.time() - t0:.0f} peakGB={parse_peak_gb(p.stderr)}"
            print(line)
            with log.open("a") as f:
                f.write(line + "\n")
            if p.returncode != 0 or not target.is_file():
                print("\n".join(p.stderr.strip().splitlines()[-8:]), file=sys.stderr)
                return 4
    return 0
