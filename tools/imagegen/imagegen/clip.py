"""Image similarity (CG3): a small open_clip embedder, a flat on-disk index and the crop / mask step that makes a crop of a
generated room comparable with a product photo on white.

Model: open_clip `ViT-B-32` with the `laion2b_s34b_b79k` weights (LAION-2B, 151M parameters, 512-d embeddings). The
open_clip code is MIT; the weights repo `laion/CLIP-ViT-B-32-laion2B-s34B-b79K` is MIT (verified on the Hugging Face
model card, see tools/imagegen/README.md). Runs on MPS, CUDA or CPU.

Everything here is stdlib except the embedder (torch + open_clip, extra `clip`) and the image steps (Pillow). The index is a
JSON file (items) next to a raw float32 file (L2-normalised vectors): no numpy needed to read or search it, and 400 products
or 100 assets search in a few milliseconds.

Privacy: the catalogue index is derived from retailer photos, so it is written only under the gitignored catalogue folder
(`apps/server/local-assets/ikea-fr/clip-index.*`); the HD / CC0 index only under `.tmp`. Nothing is uploaded anywhere.
"""

from __future__ import annotations

import array
import json
import math
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from .config import Config

SOURCES = ("catalog", "hd")
INDEX_VERSION = 1
BATCH = 32
MAX_EMBED_ITEMS = 64
MAX_TOP_K = 20
#: Edge of the square image handed to the embedder (open_clip resizes to 224 itself; this keeps enough pixels for a crop).
PREP_SIDE = 256


class ClipError(Exception):
    """An expected failure; `code` is a stable string for the HTTP layer."""

    def __init__(self, code: str, message: str, status: int = 400, field: str = ""):
        super().__init__(message)
        self.code, self.status, self.field = code, status, field


class Embedder(Protocol):
    name: str
    dim: int

    def embed_images(self, images: list[Any]) -> list[list[float]]: ...
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...


def normalise(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class OpenClipEmbedder:
    """open_clip on MPS / CUDA / CPU, loaded on first use. Weights come from the Hugging Face cache and are never fetched
    unless `allow_download` (the same rule as the generation models)."""

    def __init__(self, model: str, pretrained: str, cache_dir: Path, allow_download: bool = False, device: str | None = None):
        self.model_name, self.pretrained, self.cache_dir, self.allow_download = model, pretrained, cache_dir, allow_download
        self.name = f"{model}/{pretrained}"
        self.dim = 0
        self._device = device
        self._m: Any = None

    def _load(self) -> None:
        if self._m is not None:
            return
        import os

        if not self.allow_download:
            os.environ["HF_HUB_OFFLINE"] = "1"
        try:
            import open_clip
            import torch
        except ImportError as e:
            raise ClipError("not_implemented", f"open_clip is not installed ({e}); start the sidecar with the `clip` extra (pnpm imagegen does)", 501) from None
        dev = self._device or ("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu")
        try:
            model, _, preprocess = open_clip.create_model_and_transforms(self.model_name, pretrained=self.pretrained, cache_dir=str(self.cache_dir), device=dev)
        except Exception as e:  # noqa: BLE001 - hub errors vary; the message is what matters
            if not self.allow_download:
                raise ClipError("model_missing", f"CLIP weights {self.name} are not in the cache {self.cache_dir}; run `pnpm imagegen:setup --download` or set IMAGEGEN_ALLOW_DOWNLOAD=true ({type(e).__name__})", 409) from None
            raise
        model.eval()
        self._m = (torch, model, preprocess, open_clip.get_tokenizer(self.model_name), dev)
        self.dim = int(model.visual.output_dim)

    def embed_images(self, images: list[Any]) -> list[list[float]]:
        self._load()
        torch, model, preprocess, _tok, dev = self._m
        out: list[list[float]] = []
        with torch.no_grad():
            for i in range(0, len(images), BATCH):
                batch = torch.stack([preprocess(im) for im in images[i : i + BATCH]]).to(dev)
                f = model.encode_image(batch)
                f = f / f.norm(dim=-1, keepdim=True)
                out.extend(f.float().cpu().tolist())
        return out

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        self._load()
        torch, model, _pre, tok, dev = self._m
        out: list[list[float]] = []
        with torch.no_grad():
            for i in range(0, len(texts), BATCH):
                f = model.encode_text(tok(texts[i : i + BATCH]).to(dev))
                f = f / f.norm(dim=-1, keepdim=True)
                out.extend(f.float().cpu().tolist())
        return out

    def device(self) -> str | None:
        return self._m[4] if self._m else None


# -- image preparation (Pillow) ---------------------------------------------------------------------------------------


def _pil() -> Any:
    try:
        from PIL import Image
    except ImportError:
        raise ClipError("not_implemented", "Pillow is not installed (extra `clip`)", 501) from None
    return Image


def on_white(im: Any) -> Any:
    """RGB with any transparency flattened onto white (HD thumbnails and some photos have alpha)."""
    Image = _pil()
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        bg.alpha_composite(rgba)
        return bg.convert("RGB")
    return im.convert("RGB")


def pad_square(im: Any, margin: float = 0.06, side: int = PREP_SIDE) -> Any:
    """Fit onto a white square with a small margin: product photos are centred on white, a crop should look the same."""
    Image = _pil()
    inner = max(8, int(side * (1 - 2 * margin)))
    k = inner / max(im.size)
    w, h = max(1, round(im.width * k)), max(1, round(im.height * k))
    canvas = Image.new("RGB", (side, side), (255, 255, 255))
    canvas.paste(im.resize((w, h), Image.LANCZOS), ((side - w) // 2, (side - h) // 2))
    return canvas


def background_mask(im: Any, threshold: int = 36) -> Any | None:
    """A rough foreground mask of `im` ('L', 255 = object): pixels far from the colour of the border ring. Returns None when it
    would be useless (nearly everything or nothing selected). A crop from a generated room is mostly one object against a wall or
    floor, which is what this assumes; it is a saliency heuristic, not a segmenter."""
    Image = _pil()
    from PIL import ImageChops, ImageFilter

    small = im.copy()
    small.thumbnail((96, 96))
    w, h = small.size
    px = small.load()
    ring = [px[x, y] for x in range(w) for y in (0, h - 1)] + [px[x, y] for y in range(h) for x in (0, w - 1)]
    med = tuple(sorted(c[i] for c in ring)[len(ring) // 2] for i in range(3))
    flat = Image.new("RGB", small.size, med)
    # max over channels is closer to "different colour" than the luma mix
    chans = [ImageChops.difference(small.getchannel(i), flat.getchannel(i)) for i in range(3)]
    diff = ImageChops.lighter(ImageChops.lighter(chans[0], chans[1]), chans[2])
    m = diff.point(lambda v: 255 if v > threshold else 0).filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.MaxFilter(5))
    hist = m.histogram()
    cover = hist[255] / float(w * h)
    if cover < 0.05 or cover > 0.95:
        return None
    return m.resize(im.size, Image.BILINEAR).filter(ImageFilter.GaussianBlur(1.5))


def prepare_crop(im: Any, box: tuple[int, int, int, int] | None = None, mask: Any | None = None, background: str = "plain") -> Any:
    """Crop `box` (pixels of `im`), put the object on white and pad to a square.
    - `mask` (an 'L' image the size of `im`, 255 = object; for our own renders it comes from the CG1 instance ids) wins.
    - `background`: "plain" keeps the crop as is (reference images), "border" also whitens pixels close to the border colour."""
    Image = _pil()
    im = on_white(im)
    if box is not None:
        x0, y0, x1, y1 = box
        x0, y0, x1, y1 = max(0, min(im.width, x0)), max(0, min(im.height, y0)), max(0, min(im.width, x1)), max(0, min(im.height, y1))
        if x1 - x0 < 8 or y1 - y0 < 8:
            raise ClipError("invalid_request", "box is smaller than 8 px or outside the image", 400, "box")
        im = im.crop((x0, y0, x1, y1))
        if mask is not None:
            mask = mask.crop((x0, y0, x1, y1))
    if mask is not None:
        if mask.size != im.size:
            mask = mask.resize(im.size)
        white = Image.new("RGB", im.size, (255, 255, 255))
        im = Image.composite(im, white, mask.convert("L"))
    elif background == "border":
        m = background_mask(im)
        if m is not None:
            im = Image.composite(im, Image.new("RGB", im.size, (255, 255, 255)), m)
    return pad_square(im)


def mask_from_ids(ids_image: Any, colour: tuple[int, int, int] | None, tol: int = 2) -> Any:
    """An object mask from a CG1 instance-id image: pixels equal to `colour` (± tol per channel); with no colour, any non-black pixel."""
    from PIL import ImageChops

    rgb = ids_image.convert("RGB")
    if colour is None:
        return rgb.convert("L").point(lambda v: 255 if v > 0 else 0)
    chans = [rgb.getchannel(i).point(lambda v, c=colour[i]: 255 if abs(v - c) <= tol else 0) for i in range(3)]
    return ImageChops.darker(ImageChops.darker(chans[0], chans[1]), chans[2])


# -- items of the two sources -----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Item:
    id: str
    kind: str  # product | asset
    name: str
    category: str | None
    price: float | None
    currency: str | None
    dims: dict[str, float] | None
    has3d: bool
    file: str  # relative to the source's base folder

    def to_json(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


def source_base(cfg: Config, source: str) -> Path:
    return cfg.catalog_dir if source == "catalog" else cfg.index_dir


def index_paths(cfg: Config, source: str) -> tuple[Path, Path]:
    """`clip-index.json` + `clip-index.bin` in the catalogue folder, `hd-clip-index.*` under .tmp/imagegen/index."""
    if source == "catalog":
        return cfg.catalog_dir / "clip-index.json", cfg.catalog_dir / "clip-index.bin"
    return cfg.index_dir / "hd-clip-index.json", cfg.index_dir / "hd-clip-index.bin"


def _dims(d: Any) -> dict[str, float] | None:
    if isinstance(d, dict) and all(isinstance(d.get(k), (int, float)) for k in ("w", "d", "h")):
        return {k: round(float(d[k]), 3) for k in ("w", "d", "h")}
    return None


def catalog_items(cfg: Config) -> list[tuple[Item, Path]]:
    """Products of the local catalogue that have a photo on disk."""
    path = cfg.catalog_dir / "catalog.json"
    if not path.is_file():
        raise ClipError("catalog_missing", f"no local catalogue at {cfg.catalog_dir} (run `pnpm catalog:build`)", 409)
    entries = json.loads(path.read_text("utf8")).get("entries", [])
    out: list[tuple[Item, Path]] = []
    for e in entries:
        r = e.get("record", {})
        sku = str(r.get("sku", ""))
        photo = next((p for ext in (".webp", ".jpg", ".jpeg", ".png") if (p := cfg.catalog_dir / "photos" / f"{sku}{ext}").is_file()), None) if sku else None
        if photo is None:
            continue
        out.append((Item(f"{r.get('provider', 'ikea-fr')}:{sku}", "product", str(r.get("name", sku)), r.get("category"), r.get("price"), r.get("currency"), _dims(r.get("dims")), bool(e.get("has3d")), photo.name), photo))
    return out


def hd_items(cfg: Config) -> list[tuple[Item, Path]]:
    """Library models (CC0 / CC-BY) with a committed thumbnail."""
    out: list[tuple[Item, Path]] = []
    for base in cfg.hd_dirs:
        cat = base / "catalog.json"
        if not cat.is_file():
            continue
        for a in json.loads(cat.read_text("utf8")):
            thumb = a.get("thumb")
            if not thumb or not (base / thumb).is_file():
                continue
            out.append((Item(str(a["id"]), "asset", str(a.get("name", a["id"])), a.get("category"), None, None, _dims(a.get("nativeDims")), True, f"{base.name}/{thumb}"), base / thumb))
    return out


# -- the index --------------------------------------------------------------------------------------------------------


@dataclass
class Index:
    source: str
    model: str
    dim: int
    built_at: str
    items: list[dict[str, Any]]
    vectors: array.array  # count * dim float32, each row L2-normalised

    def search(self, q: list[float], top_k: int, category: str | None = None, max_price: float | None = None) -> list[tuple[float, dict[str, Any]]]:
        if len(q) != self.dim:
            raise ClipError("invalid_request", f"query has {len(q)} dims, the index {self.dim}")
        scored: list[tuple[float, dict[str, Any]]] = []
        v, d = self.vectors, self.dim
        for i, it in enumerate(self.items):
            if category and it.get("category") != category:
                continue
            if max_price is not None and it.get("price") is not None and it["price"] > max_price:
                continue
            base = i * d
            scored.append((sum(q[j] * v[base + j] for j in range(d)), it))
        scored.sort(key=lambda t: -t[0])
        return scored[:top_k]


def write_index(json_path: Path, bin_path: Path, source: str, model: str, dim: int, items: list[Item], vectors: list[list[float]]) -> None:
    json_path.parent.mkdir(parents=True, exist_ok=True)
    flat = array.array("f")
    for row in vectors:
        flat.extend(normalise(row))
    tmp_bin, tmp_json = bin_path.with_suffix(".bin.tmp"), json_path.with_suffix(".json.tmp")
    tmp_bin.write_bytes(flat.tobytes())
    tmp_json.write_text(json.dumps({"version": INDEX_VERSION, "source": source, "model": model, "dim": dim, "count": len(items), "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "items": [i.to_json() for i in items]}, separators=(",", ":")), "utf8")
    tmp_bin.replace(bin_path)
    tmp_json.replace(json_path)


def read_index(json_path: Path, bin_path: Path, source: str) -> Index:
    meta = json.loads(json_path.read_text("utf8"))
    vec = array.array("f")
    vec.frombytes(bin_path.read_bytes())
    if meta.get("version") != INDEX_VERSION or len(vec) != meta["count"] * meta["dim"]:
        raise ClipError("index_corrupt", f"{json_path.name} does not match its .bin file; rebuild it", 409)
    return Index(source, meta["model"], meta["dim"], meta["builtAt"], meta["items"], vec)


# -- the service ------------------------------------------------------------------------------------------------------


class ClipService:
    """Embedder (lazy, one call at a time) + the two indexes (reloaded when the file changes)."""

    def __init__(self, cfg: Config, embedder: Embedder | Callable[[], Embedder] | None = None, allow_download: bool = False):
        self.cfg = cfg
        self._embedder = embedder if embedder is not None and not callable(embedder) else None
        self._factory = embedder if callable(embedder) else None
        self._allow = allow_download
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, Index]] = {}

    def embedder(self) -> Embedder:
        if self._embedder is None:
            self._embedder = self._factory() if self._factory else OpenClipEmbedder(self.cfg.clip_model, self.cfg.clip_pretrained, self.cfg.hf_home / "hub", self._allow)
        return self._embedder

    def model_name(self) -> str:
        return self.embedder().name

    # -- embedding
    def embed(self, images: list[Any], texts: list[str]) -> dict[str, Any]:
        if len(images) + len(texts) > MAX_EMBED_ITEMS or not (images or texts):
            raise ClipError("invalid_request", f"give 1 to {MAX_EMBED_ITEMS} images and/or texts")
        with self._lock:
            e = self.embedder()
            im_v = e.embed_images(images) if images else []
            tx_v = e.embed_texts(texts) if texts else []
        r = lambda rows: [[round(x, 6) for x in row] for row in rows]  # noqa: E731
        return {"model": e.name, "dim": e.dim, "images": r(im_v), "texts": r(tx_v)}

    # -- index
    def build(self, source: str) -> dict[str, Any]:
        if source not in SOURCES:
            raise ClipError("invalid_request", f"source must be one of {', '.join(SOURCES)}", 400, "source")
        t0 = time.time()
        pairs = catalog_items(self.cfg) if source == "catalog" else hd_items(self.cfg)
        if not pairs:
            raise ClipError("nothing_to_index", f"no images found for source {source}", 409)
        Image = _pil()
        imgs = []
        for _item, path in pairs:
            with Image.open(path) as im:
                imgs.append(pad_square(on_white(im)))
        with self._lock:
            e = self.embedder()
            vectors: list[list[float]] = []
            for i in range(0, len(imgs), 64):
                vectors.extend(e.embed_images(imgs[i : i + 64]))
        jp, bp = index_paths(self.cfg, source)
        write_index(jp, bp, source, e.name, e.dim, [p[0] for p in pairs], vectors)
        self._cache.pop(source, None)
        return {"source": source, "count": len(pairs), "model": e.name, "dim": e.dim, "seconds": round(time.time() - t0, 1), "bytes": jp.stat().st_size + bp.stat().st_size, "path": str(jp.parent)}

    def load(self, source: str) -> Index | None:
        jp, bp = index_paths(self.cfg, source)
        if not jp.is_file() or not bp.is_file():
            return None
        mt = max(jp.stat().st_mtime, bp.stat().st_mtime)
        hit = self._cache.get(source)
        if hit and hit[0] == mt:
            return hit[1]
        idx = read_index(jp, bp, source)
        self._cache[source] = (mt, idx)
        return idx

    def status(self) -> dict[str, Any]:
        out: dict[str, Any] = {"model": f"{self.cfg.clip_model}/{self.cfg.clip_pretrained}"}
        for s in SOURCES:
            jp, bp = index_paths(self.cfg, s)
            if jp.is_file() and bp.is_file():
                try:
                    i = self.load(s)
                    out[s] = {"count": len(i.items), "builtAt": i.built_at, "model": i.model} if i else None
                except ClipError as e:
                    out[s] = {"error": str(e)}
            else:
                out[s] = None
        return out

    def query(self, vector: list[float], top_k: int, sources: list[str], category: str | None, max_price: float | None) -> dict[str, Any]:
        if not 1 <= top_k <= MAX_TOP_K:
            raise ClipError("invalid_request", f"topK must be 1 to {MAX_TOP_K}", 400, "topK")
        hits: list[tuple[float, dict[str, Any]]] = []
        missing: list[str] = []
        for s in sources:
            idx = self.load(s)
            if idx is None:
                missing.append(s)
                continue
            if idx.model != self.model_name():
                raise ClipError("index_stale", f"the {s} index was built with {idx.model}, the server uses {self.model_name()}; rebuild it", 409)
            hits.extend(idx.search(vector, top_k, category, max_price))
        if missing and len(missing) == len(sources):
            raise ClipError("index_missing", f"no index for {', '.join(missing)}: POST /index/build {{source}} or run `pnpm imagegen:index`", 409)
        hits.sort(key=lambda t: -t[0])
        return {"model": self.model_name(), "results": [{**it, "score": round(sc, 4)} for sc, it in hits[:top_k]], **({"missing": missing} if missing else {})}
