"""The models the sidecar knows, their Hugging Face repos per backend, and a presence check on the local cache."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

#: Diffusers stand-ins (see README "Differences between the backends"): the Fun-Controlnet-Union checkpoint is in the
#: VideoX-Fun format, which diffusers cannot load, so the CUDA backend uses Qwen-Image + InstantX ControlNet-Union.
DIFFUSERS_QWEN_BASE = "Qwen/Qwen-Image"
DIFFUSERS_QWEN_CONTROLNET = "InstantX/Qwen-Image-ControlNet-Union"
DIFFUSERS_QWEN_LIGHTNING = "lightx2v/Qwen-Image-Lightning"
DIFFUSERS_QWEN_LIGHTNING_FILE = "Qwen-Image-Lightning-8steps-V1.1.safetensors"
DIFFUSERS_KLEIN = "black-forest-labs/FLUX.2-klein-4B"


@dataclass(frozen=True)
class Repo:
    repo: str
    #: Only these file patterns are needed (None: the whole repo).
    patterns: tuple[str, ...] | None = None


@dataclass(frozen=True)
class ModelSpec:
    id: str
    cli: str  # name of the mflux executable
    mflux_model: str
    mflux_repos: tuple[Repo, ...]
    size_gb: float
    diffusers_size_gb: float
    default_steps: int
    quantize: int | None
    default_size: tuple[int, int]
    licence: str


MODELS: dict[str, ModelSpec] = {
    "qwen-cn": ModelSpec(
        id="qwen-cn",
        cli="mflux-generate-qwen-2.1-controlnet",
        mflux_model="qwen-image-2.1-turbo-controlnet-union",
        mflux_repos=(Repo("Qwen/Qwen-Image-2.1-Turbo"), Repo("alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union")),
        size_gb=39.0,
        diffusers_size_gb=62.0,
        default_steps=8,
        quantize=8,
        default_size=(1024, 768),
        licence="Qwen-Image Apache-2.0; mflux ControlNet (Fun-Controlnet-Union): Qwen RESEARCH LICENSE, non-commercial; diffusers ControlNet (InstantX): see README",
    ),
    "klein-edit": ModelSpec(
        id="klein-edit",
        cli="mflux-generate-flux2-edit",
        mflux_model="flux2-klein-4b",
        mflux_repos=(Repo("black-forest-labs/FLUX.2-klein-4B"),),
        size_gb=23.0,
        diffusers_size_gb=23.0,
        default_steps=4,
        quantize=None,
        default_size=(1024, 768),
        licence="Apache-2.0 (4B)",
    ),
}


def required_repos(model_id: str, backend: str, lightning: bool = True) -> tuple[Repo, ...]:
    if backend == "mflux":
        return MODELS[model_id].mflux_repos
    if model_id == "klein-edit":
        return (Repo(DIFFUSERS_KLEIN),)
    repos = [Repo(DIFFUSERS_QWEN_BASE), Repo(DIFFUSERS_QWEN_CONTROLNET)]
    if lightning:
        repos.append(Repo(DIFFUSERS_QWEN_LIGHTNING, (DIFFUSERS_QWEN_LIGHTNING_FILE,)))
    return tuple(repos)


def repo_dir(hf_home: Path, repo: str) -> Path:
    return hf_home / "hub" / ("models--" + repo.replace("/", "--"))


def repo_present(hf_home: Path, repo: str) -> bool:
    """True when the cache holds a snapshot with weights (a bare refs/ folder from a failed download does not count)."""
    snaps = repo_dir(hf_home, repo) / "snapshots"
    if not snaps.is_dir():
        return False
    return any(any(snap.rglob("*.safetensors")) for snap in snaps.iterdir())


def downloaded(hf_home: Path, model_id: str, backend: str = "mflux", lightning: bool = True) -> bool:
    return all(repo_present(hf_home, r.repo) for r in required_repos(model_id, backend, lightning))
