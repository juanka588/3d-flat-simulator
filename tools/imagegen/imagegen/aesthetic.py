"""Aesthetic score (CG5): the LAION aesthetic predictor, a single linear layer (512 -> 1) on the CLIP ViT-B/32 image embedding.

Licences (read from the upstream files, 2026-10): `LAION-AI/aesthetic-predictor` is MIT (LICENSE, Copyright 2022 LAION AI), and
the weights `sa_0_4_vit_b_32_linear.pth` (3 KB) are part of that repo; the embedder is OpenAI CLIP ViT-B/32 through
open_clip (`ViT-B-32` / `openai`), which is MIT. The predictor was trained on the OPENAI ViT-B/32 embedding, so it has its
own embedder: the LAION-2B one used by the similarity index would give meaningless numbers.

The score is roughly 1 to 10 (a mean opinion score; 5 is an average photo, 6.5+ is a good one). It is a weak signal for
"does this look like a nice photo", not a verdict on a 3D render; the runner reports it next to the other metrics only.

Nothing is downloaded unless the sidecar was started with downloads allowed (`--download` / IMAGEGEN_ALLOW_DOWNLOAD).
"""

from __future__ import annotations

import urllib.request
from pathlib import Path
from typing import Any, Protocol

from .clip import ClipError, OpenClipEmbedder
from .config import Config

WEIGHTS_NAME = "sa_0_4_vit_b_32_linear.pth"
WEIGHTS_URL = "https://github.com/LAION-AI/aesthetic-predictor/raw/main/" + WEIGHTS_NAME
LICENCE = "MIT (LAION-AI/aesthetic-predictor; open_clip ViT-B-32 openai weights, MIT)"


class Embedder(Protocol):
    name: str

    def embed_images(self, images: list[Any]) -> list[list[float]]: ...


def weights_path(cfg: Config) -> Path:
    return cfg.hf_home / "aesthetic" / WEIGHTS_NAME


def fetch_weights(cfg: Config) -> Path:
    p = weights_path(cfg)
    if p.is_file():
        return p
    p.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(WEIGHTS_URL, timeout=30) as r:  # noqa: S310 - fixed https URL
        data = r.read(1_000_000)
    p.write_bytes(data)
    return p


def load_linear(path: Path) -> tuple[list[float], float]:
    """The (weight, bias) of the predictor's single linear layer."""
    import torch

    sd = torch.load(path, map_location="cpu", weights_only=True)
    w = next((v for k, v in sd.items() if k.endswith("weight")), None)
    b = next((v for k, v in sd.items() if k.endswith("bias")), None)
    if w is None or b is None or w.numel() != 512:
        raise ClipError("model_missing", f"{path} is not the 512-d linear aesthetic predictor", 409)
    return [float(x) for x in w.reshape(-1).tolist()], float(b.reshape(-1)[0])


class AestheticScorer:
    """Lazy: the CLIP model and the weights load on the first call. `embedder` and `linear` are injectable for tests."""

    def __init__(self, cfg: Config, allow_download: bool = False, embedder: Embedder | None = None, linear: tuple[list[float], float] | None = None):
        self.cfg, self._allow = cfg, allow_download
        self._embedder = embedder
        self._linear = linear

    def _load(self) -> tuple[Embedder, tuple[list[float], float]]:
        if self._embedder is None:
            self._embedder = OpenClipEmbedder("ViT-B-32", "openai", self.cfg.hf_home / "hub", self._allow)
        if self._linear is None:
            p = weights_path(self.cfg)
            if not p.is_file():
                if not self._allow:
                    raise ClipError("model_missing", f"aesthetic predictor weights are not at {p}; start the sidecar with --download once (downloads {WEIGHTS_NAME}, 3 KB, and the OpenAI ViT-B/32 CLIP weights, 0.6 GB), or skip the aesthetic score", 409)
                try:
                    fetch_weights(self.cfg)
                except OSError as e:
                    raise ClipError("model_missing", f"could not download {WEIGHTS_NAME}: {e}", 409) from None
            self._linear = load_linear(p)
        return self._embedder, self._linear

    def score(self, images: list[Any]) -> dict[str, Any]:
        emb, (w, b) = self._load()
        vecs = emb.embed_images(images)
        return {"model": f"{emb.name} + {WEIGHTS_NAME}", "licence": LICENCE, "scores": [round(sum(a * c for a, c in zip(v, w)) + b, 3) for v in vecs]}
