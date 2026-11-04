"""The three small models of the evaluation, loaded lazily (extra `eval`; torch comes from the `mflux`/`cuda`/`clip` extra).

Licences (read from each Hugging Face model card, 2026-11):
  depth     depth-anything/Depth-Anything-V2-Small-hf   Apache-2.0 (the Small checkpoint; Base/Large/Giant are CC-BY-NC)
  seg       openmmlab/upernet-convnext-small            MIT (weights trained on ADE20K, used for scoring only, nothing is shipped)
  clip      open_clip ViT-B-32 laion2b_s34b_b79k        MIT (the sidecar's similarity model, shared cache)
The models are only used to score images offline; no weights or outputs are committed.

Offline by default: HF_HOME follows the sidecar (IMAGEGEN_HF_HOME) and HF_HUB_OFFLINE=1 unless `--download` is given.
"""

from __future__ import annotations

import os

import numpy as np

from ..config import from_env

DEPTH_REPO = "depth-anything/Depth-Anything-V2-Small-hf"
SEG_REPO = "openmmlab/upernet-convnext-small"
CLIP_MODEL, CLIP_PRETRAINED = "ViT-B-32", "laion2b_s34b_b79k"
LICENCES = {DEPTH_REPO: "Apache-2.0", SEG_REPO: "MIT", f"open_clip {CLIP_MODEL}/{CLIP_PRETRAINED}": "MIT"}
CLIP_LABELS = [
    "a photo of a window or a glazed balcony door", "a photo of an interior door", "a photo of a plain wall", "a photo of a ceiling",
    "a photo of a floor", "a photo of a sofa", "a photo of a kitchen cabinet", "a photo of a radiator", "a photo of a bed",
]


def configure_hf(download: bool = False, env: dict[str, str] | None = None) -> None:
    """Point the Hugging Face cache at the sidecar's (IMAGEGEN_HF_HOME) and stay offline unless `download`."""
    cfg = from_env(env if env is not None else dict(os.environ))
    os.environ["HF_HOME"] = str(cfg.hf_home)
    if download:
        os.environ.pop("HF_HUB_OFFLINE", None)
    else:
        os.environ["HF_HUB_OFFLINE"] = "1"


class Estimators:
    """disparity(img) -> float array (bright = near); segment(img) -> ADE20K label array; opening_recall(img, boxes) -> 0..1 or None."""

    def __init__(self) -> None:
        import torch

        self.torch = torch
        self.dev = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
        self._m: dict = {}

    def disparity(self, img) -> np.ndarray:  # noqa: ANN001
        torch = self.torch
        if "da" not in self._m:
            from transformers import AutoImageProcessor, AutoModelForDepthEstimation

            self._m["da"] = (AutoImageProcessor.from_pretrained(DEPTH_REPO), AutoModelForDepthEstimation.from_pretrained(DEPTH_REPO).to(self.dev).eval())
        proc, m = self._m["da"]
        with torch.no_grad():
            x = proc(images=img, return_tensors="pt").to(self.dev)
            d = m(**x).predicted_depth[None].float()
            d = torch.nn.functional.interpolate(d, size=(img.height, img.width), mode="bicubic")[0, 0]
        return d.cpu().numpy()

    def segment(self, img) -> np.ndarray:  # noqa: ANN001
        torch = self.torch
        if "seg" not in self._m:
            from transformers import AutoImageProcessor, UperNetForSemanticSegmentation

            self._m["seg"] = (AutoImageProcessor.from_pretrained(SEG_REPO), UperNetForSemanticSegmentation.from_pretrained(SEG_REPO).eval())
        proc, m = self._m["seg"]
        with torch.no_grad():  # CPU: adaptive pooling is not supported on MPS for odd sizes
            lg = m(**proc(images=img, return_tensors="pt")).logits
            lg = torch.nn.functional.interpolate(lg, size=(img.height, img.width), mode="bilinear")
        return lg.argmax(1)[0].cpu().numpy()

    def opening_recall(self, img, boxes) -> float | None:  # noqa: ANN001
        """Zero-shot CLIP on a crop (10 % margin) of every expected opening: window or door must beat plain wall and the other classes."""
        if not boxes:
            return None
        torch = self.torch
        if "clip" not in self._m:
            import open_clip

            m, _, pre = open_clip.create_model_and_transforms(CLIP_MODEL, pretrained=CLIP_PRETRAINED)
            self._m["clip"] = (m.to(self.dev).eval(), pre, open_clip.get_tokenizer(CLIP_MODEL))
        m, pre, tok = self._m["clip"]
        hit = 0
        with torch.no_grad():
            t = m.encode_text(tok(CLIP_LABELS).to(self.dev))
            t /= t.norm(dim=-1, keepdim=True)
            for x0, y0, x1, y1 in boxes:
                pw, ph = int((x1 - x0) * 0.1) + 4, int((y1 - y0) * 0.1) + 4
                crop = img.crop((max(0, x0 - pw), max(0, y0 - ph), min(img.width, x1 + pw), min(img.height, y1 + ph)))
                f = m.encode_image(pre(crop)[None].to(self.dev))
                f /= f.norm(dim=-1, keepdim=True)
                p = (100 * f @ t.T).softmax(-1)[0].cpu().numpy()
                hit += int(p[0] + p[1] > p[2] and max(p[0], p[1]) >= p[3:].max())
        return hit / len(boxes)
