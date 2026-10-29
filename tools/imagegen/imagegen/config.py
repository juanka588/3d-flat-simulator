"""Paths and settings, read from the environment once. Nothing here touches the network."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_PARENTS = Path(__file__).resolve().parents
#: The repo root when run from a checkout (tools/imagegen/imagegen/config.py); /app/imagegen/config.py in Docker, where every path comes from the environment.
REPO_ROOT = _PARENTS[3] if len(_PARENTS) > 3 else Path("/data")
DEFAULT_PORT = 8790
BACKENDS = ("mflux", "diffusers")


@dataclass(frozen=True)
class Config:
    #: Interface to bind. 127.0.0.1 unless IMAGEGEN_BIND says otherwise (the Docker image binds 0.0.0.0 inside the
    #: container; compose publishes the port on 127.0.0.1 only).
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    backend: str = "mflux"
    #: Hugging Face cache. Point IMAGEGEN_HF_HOME at an existing cache (e.g. the CG0 spike one) to avoid a re-download.
    hf_home: Path = REPO_ROOT / ".tmp" / "imagegen" / "hf-cache"
    out_dir: Path = REPO_ROOT / ".tmp" / "imagegen" / "out"
    in_dir: Path = REPO_ROOT / ".tmp" / "imagegen" / "in"
    #: Directories an `image` path may point into (the repo by default).
    input_roots: tuple[Path, ...] = (REPO_ROOT,)
    #: Browsers send Origin on cross-site requests; only these are accepted (none by default: the MCP sends no Origin).
    allowed_origins: tuple[str, ...] = ()
    #: Host header values accepted besides localhost / 127.0.0.1 / [::1] (a LAN address when the port is published on it).
    allowed_hosts: tuple[str, ...] = ()
    #: When set, every request needs `Authorization: Bearer <token>`. Strongly advised with any non-loopback publishing.
    token: str | None = None
    #: Directory holding the mflux-* executables (the venv bin dir by default).
    bin_dir: Path | None = None
    #: Jobs run with HF_HUB_OFFLINE=1 unless this is set (`--download`).
    allow_download: bool = False
    max_body_bytes: int = 48 * 1024 * 1024
    #: Longest image edge accepted (IMAGEGEN_MAX_SIDE; the diffusers profile sets it from the VRAM).
    max_side: int = 1536
    #: Default steps for qwen-cn when the request gives none (None: the model's own default).
    steps: int | None = None


def _paths(value: str | None) -> list[Path]:
    return [Path(p).expanduser().resolve() for p in (value or "").split(os.pathsep) if p.strip()]


def _list(value: str | None) -> tuple[str, ...]:
    return tuple(o.strip() for o in (value or "").split(",") if o.strip())


def env_get(e: dict[str, str], key: str) -> str | None:
    """An env var, with the empty string (compose passes unset knobs as empty) counting as unset."""
    v = e.get(key)
    return v.strip() if v and v.strip() else None


def from_env(env: dict[str, str] | None = None) -> Config:
    e = dict(os.environ if env is None else env)
    base = Config()
    roots = _paths(e.get("IMAGEGEN_INPUT_ROOTS")) or list(base.input_roots)
    out = Path(e["IMAGEGEN_OUT"]).expanduser().resolve() if env_get(e, "IMAGEGEN_OUT") else base.out_dir
    backend = env_get(e, "IMAGEGEN_BACKEND") or base.backend
    if backend not in BACKENDS:
        raise SystemExit(f"IMAGEGEN_BACKEND must be one of {', '.join(BACKENDS)} (got {backend!r})")
    return Config(
        host=env_get(e, "IMAGEGEN_BIND") or base.host,
        port=int(env_get(e, "IMAGEGEN_PORT") or base.port),
        backend=backend,
        hf_home=Path(e["IMAGEGEN_HF_HOME"]).expanduser().resolve() if env_get(e, "IMAGEGEN_HF_HOME") else base.hf_home,
        out_dir=out,
        in_dir=out.parent / "in",
        input_roots=tuple(roots),
        allowed_origins=_list(e.get("IMAGEGEN_ALLOWED_ORIGINS")),
        allowed_hosts=_list(e.get("IMAGEGEN_ALLOWED_HOSTS")),
        token=env_get(e, "IMAGEGEN_TOKEN"),
        bin_dir=Path(e["IMAGEGEN_BIN_DIR"]).expanduser().resolve() if env_get(e, "IMAGEGEN_BIN_DIR") else None,
        max_side=int(env_get(e, "IMAGEGEN_MAX_SIDE") or base.max_side),
        steps=int(env_get(e, "IMAGEGEN_STEPS")) if env_get(e, "IMAGEGEN_STEPS") else None,
    )
