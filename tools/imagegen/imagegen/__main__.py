"""`python -m imagegen serve|check|preflight`. See tools/imagegen/README.md."""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys

from .config import from_env
from .models import MODELS, downloaded, required_repos, repo_present


def _lightning() -> bool:
    return os.environ.get("IMAGEGEN_LIGHTNING", "true").strip().lower() in ("1", "true", "yes", "on", "")


def cmd_check(args: argparse.Namespace) -> int:
    cfg = from_env()
    light = _lightning()
    print(f"backend: {cfg.backend}\nHF cache: {cfg.hf_home}")
    missing = []
    for m in MODELS.values():
        ok = downloaded(cfg.hf_home, m.id, cfg.backend, light)
        size = m.size_gb if cfg.backend == "mflux" else m.diffusers_size_gb
        repos = ", ".join(r.repo for r in required_repos(m.id, cfg.backend, light))
        print(f"  {m.id:11} {'present' if ok else 'MISSING':8} ~{size:.0f} GB  ({repos})")
        print(f"              licence: {m.licence}")
        if not ok:
            missing.append(m)
    clip_repo = cfg.hf_home / "hub" / "models--laion--CLIP-ViT-B-32-laion2B-s34B-b79K"
    clip_ok = (clip_repo / "snapshots").is_dir() and any((clip_repo / "snapshots").iterdir())
    print(f"  {'clip':11} {'present' if clip_ok else 'MISSING':8} ~0.6 GB  ({cfg.clip_model}/{cfg.clip_pretrained}, MIT; optional: only the similarity index needs it)")
    if not clip_ok and args.download:
        from .clip import OpenClipEmbedder

        print("downloading the CLIP weights ...", flush=True)
        OpenClipEmbedder(cfg.clip_model, cfg.clip_pretrained, cfg.hf_home / "hub", allow_download=True)._load()
    if not missing:
        print("All models present.")
        return 0
    if not args.download:
        print("\nNothing is downloaded automatically. Re-run with --download to fetch the missing models,")
        print("or set IMAGEGEN_HF_HOME to a cache that already holds them (see tools/imagegen/README.md).")
        return 1
    from huggingface_hub import snapshot_download

    for m in missing:
        for r in required_repos(m.id, cfg.backend, light):
            if repo_present(cfg.hf_home, r.repo):
                continue
            print(f"downloading {r.repo} ...", flush=True)
            snapshot_download(repo_id=r.repo, cache_dir=str(cfg.hf_home / "hub"), allow_patterns=list(r.patterns) if r.patterns else None)
    return 0 if all(downloaded(cfg.hf_home, m.id, cfg.backend, light) for m in missing) else 1


def cmd_preflight(_args: argparse.Namespace) -> int:
    from .diffusers_backend import PreflightError, preflight
    from .profiles import SettingsError, fit_report, resolve_settings

    try:
        gpu = preflight()
        s = resolve_settings(dict(os.environ), gpu["vramGb"])
    except (PreflightError, SettingsError) as e:
        print(f"preflight FAILED: {e}", file=sys.stderr)
        return 2
    print(f"GPU {gpu['name']}  {gpu['vramGb']} GB  {gpu['capability']}  torch {gpu['torch']}  CUDA {gpu['cuda']}  kernels: {gpu['kernels']}")
    print(f"profile {s.profile}: {s.to_json()}")
    rep = fit_report(s, gpu["vramGb"])
    print(f"estimated peak VRAM (unmeasured): qwen-cn {rep['qwen-cn']['estimatedPeakGb']} GB, klein-edit {rep['klein-edit']['estimatedPeakGb']} GB; system RAM wanted ~{rep['systemRamGb']:.0f} GB")
    for w in rep["warnings"]:
        print(f"WARNING: {w}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    from .clip import ClipService
    from .jobs import JobQueue
    from .server import make_server

    cfg = from_env()
    allow = args.download or os.environ.get("IMAGEGEN_ALLOW_DOWNLOAD", "").strip().lower() in ("1", "true", "yes", "on")
    cfg = dataclasses.replace(cfg, port=args.port or cfg.port, allow_download=allow)
    info: dict = {}
    if cfg.backend == "diffusers":
        os.environ["HF_HOME"] = str(cfg.hf_home)  # before torch / diffusers are imported
        if not cfg.allow_download:
            os.environ["HF_HUB_OFFLINE"] = "1"
        from .diffusers_backend import DiffusersRunner, PreflightError, preflight
        from .profiles import SettingsError, fit_report, resolve_settings

        try:
            gpu = preflight()
            settings = resolve_settings(dict(os.environ), gpu["vramGb"])
        except (PreflightError, SettingsError) as e:
            print(f"imagegen: cannot start the diffusers backend: {e}", file=sys.stderr)
            return 2
        cfg = dataclasses.replace(cfg, max_side=settings.max_side, steps=settings.steps)
        runner = DiffusersRunner(cfg, settings, log=lambda m: print(m, file=sys.stderr, flush=True))
        fit = fit_report(settings, gpu["vramGb"])
        info = {"gpu": gpu, "settings": settings.to_json(), "fit": {k: v for k, v in fit.items() if k != "warnings"}, "warnings": fit["warnings"], "loaded": lambda: runner._name}
        for w in fit["warnings"]:
            print(f"[imagegen] WARNING: {w}", file=sys.stderr)
        print(f"[imagegen] GPU {gpu['name']} {gpu['vramGb']} GB {gpu['capability']} torch {gpu['torch']} CUDA {gpu['cuda']}; profile {settings.profile}", file=sys.stderr, flush=True)
    else:
        from .runner import MfluxRunner

        runner = MfluxRunner(cfg)
    if cfg.host not in ("127.0.0.1", "localhost", "::1") and not cfg.token:
        print(f"[imagegen] WARNING: bound to {cfg.host} without IMAGEGEN_TOKEN: anything that can reach the port can use the GPU", file=sys.stderr)
    queue = JobQueue(runner, cfg.unload_after)
    if cfg.unload_after is not None and cfg.backend == "mflux":
        print("[imagegen] IMAGEGEN_UNLOAD_AFTER has no effect with the mflux backend: it runs one process per image and holds no model between images", file=sys.stderr)
    srv = make_server(cfg, queue, info, ClipService(cfg, allow_download=allow))
    print(f"[imagegen] {cfg.backend} backend listening on http://{cfg.host}:{cfg.port} (HF cache {cfg.hf_home}, out {cfg.out_dir})", file=sys.stderr, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        queue.stop()
        srv.server_close()
    return 0


def cmd_index(args: argparse.Namespace) -> int:
    """Builds the similarity index without the server (the sidecar picks it up by file time)."""
    from .clip import SOURCES, ClipError, ClipService

    cfg = from_env()
    svc = ClipService(cfg, allow_download=args.download or os.environ.get("IMAGEGEN_ALLOW_DOWNLOAD", "").strip().lower() in ("1", "true", "yes", "on"))
    rc = 0
    for src in SOURCES if args.source == "all" else (args.source,):
        try:
            print(json.dumps(svc.build(src)), flush=True)
        except ClipError as e:
            print(f"index {src}: {e}", file=sys.stderr)
            rc = 1
    return rc


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="imagegen")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=0, help="default: IMAGEGEN_PORT or 8790")
    s.add_argument("--download", action="store_true", help="let jobs fetch missing models (off by default: offline)")
    c = sub.add_parser("check")
    c.add_argument("--download", action="store_true")
    i = sub.add_parser("index", help="build the CLIP similarity index (catalogue photos and / or HD thumbnails)")
    i.add_argument("--source", choices=["catalog", "hd", "all"], default="all")
    i.add_argument("--download", action="store_true", help="allow fetching the CLIP weights if missing")
    sub.add_parser("preflight", help="diffusers backend: check the GPU, the torch kernels and the profile")
    args = p.parse_args(argv)
    return {"serve": cmd_serve, "check": cmd_check, "preflight": cmd_preflight, "index": cmd_index}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
