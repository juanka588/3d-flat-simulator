"""Request validation. Everything a client sends is checked here before it can reach a command line."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import Config
from .models import MODELS

MIN_EDGE, MAX_EDGE, MAX_PIXELS, MULTIPLE = 256, 1536, 1536 * 1152, 32
MAX_PROMPT = 2000
MAX_IMAGES = 4
MAX_STEPS = 50
MAX_IMAGE_BYTES = 24 * 1024 * 1024
CONTROL_TYPES = ("canny", "depth")
IMAGE_EXTS = (".png", ".jpg", ".jpeg")
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_B64 = re.compile(r"^data:image/(png|jpeg);base64,", re.I)
_B64_ONLY = re.compile(r"^[A-Za-z0-9+/=\s]+$")


class ValidationError(ValueError):
    def __init__(self, message: str, field_name: str = "") -> None:
        super().__init__(message)
        self.field = field_name


@dataclass(frozen=True)
class Control:
    type: str
    path: Path
    strength: float


@dataclass(frozen=True)
class JobSpec:
    kind: str  # "generate" | "edit"
    model: str
    prompt: str
    negative_prompt: str | None
    seed: int
    n: int
    width: int | None
    height: int | None
    steps: int
    controls: tuple[Control, ...] = ()
    image: Path | None = None
    strength: float | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)


def _obj(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValidationError("body must be a JSON object")
    return body


def _unknown(body: dict[str, Any], allowed: set[str]) -> None:
    extra = sorted(set(body) - allowed)
    if extra:
        raise ValidationError(f"unknown field(s): {', '.join(extra)}", extra[0])


def _int(body: dict[str, Any], key: str, lo: int, hi: int, default: int | None = None) -> int:
    v = body.get(key, default)
    if v is None:
        raise ValidationError(f"{key} is required", key)
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValidationError(f"{key} must be an integer", key)
    if not lo <= v <= hi:
        raise ValidationError(f"{key} must be between {lo} and {hi}", key)
    return v


def _num(v: Any, key: str, lo: float, hi: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        raise ValidationError(f"{key} must be a number", key)
    if not lo <= v <= hi:
        raise ValidationError(f"{key} must be between {lo} and {hi}", key)
    return float(v)


def _text(body: dict[str, Any], key: str, required: bool) -> str | None:
    v = body.get(key)
    if v is None:
        if required:
            raise ValidationError(f"{key} is required", key)
        return None
    if not isinstance(v, str):
        raise ValidationError(f"{key} must be a string", key)
    v = v.strip()
    if required and not v:
        raise ValidationError(f"{key} must not be empty", key)
    if len(v) > MAX_PROMPT:
        raise ValidationError(f"{key} is longer than {MAX_PROMPT} characters", key)
    if _CTRL.search(v):
        raise ValidationError(f"{key} contains control characters", key)
    return v or None


def validate_size(width: Any, height: Any, max_side: int = MAX_EDGE) -> tuple[int, int]:
    """Both edges: a multiple of 32 in [256, max_side (at most 1536)], at most 1536x1152 pixels."""
    max_side = min(max_side, MAX_EDGE)
    for name, v in (("width", width), ("height", height)):
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValidationError(f"{name} must be an integer", name)
        if v < MIN_EDGE or v > max_side:
            raise ValidationError(f"{name} must be between {MIN_EDGE} and {max_side}", name)
        if v % MULTIPLE:
            raise ValidationError(f"{name} must be a multiple of {MULTIPLE}", name)
    if width * height > MAX_PIXELS:
        raise ValidationError(f"{width}x{height} is more than {MAX_PIXELS} pixels", "width")
    return width, height


def _size(body: dict[str, Any], default: tuple[int, int] | None, cfg: Config) -> tuple[int | None, int | None]:
    w, h = body.get("width"), body.get("height")
    if w is None and h is None:
        if not default:
            return None, None
        dw, dh = default  # shrink the default to the largest edge this server allows
        if max(dw, dh) > cfg.max_side:
            k = cfg.max_side / max(dw, dh)
            dw, dh = max(MIN_EDGE, int(dw * k) // MULTIPLE * MULTIPLE), max(MIN_EDGE, int(dh * k) // MULTIPLE * MULTIPLE)
        return dw, dh
    if w is None or h is None:
        raise ValidationError("give both width and height, or neither", "width")
    return validate_size(w, h, cfg.max_side)


def _model(body: dict[str, Any]) -> str:
    m = body.get("model")
    if m not in MODELS:
        raise ValidationError(f"model must be one of {', '.join(MODELS)}", "model")
    return m


def _sniff(data: bytes) -> bool:
    return data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8\xff")


def resolve_image(value: Any, key: str, cfg: Config) -> Path:
    """An image given as a path (must sit under an allowed root) or base64 PNG/JPEG (written to the sidecar's `in/`)."""
    if not isinstance(value, str) or not value:
        raise ValidationError(f"{key} must be a path or base64 string", key)
    # A path ends in an image extension, so it always holds a "." that base64 never has.
    if _B64.match(value) or _B64_ONLY.match(value):
        raw = _B64.sub("", value)
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            raise ValidationError(f"{key} is not valid base64", key) from None
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ValidationError(f"{key} image is empty or larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB", key)
        if not _sniff(data):
            raise ValidationError(f"{key} must be a PNG or JPEG image", key)
        cfg.in_dir.mkdir(parents=True, exist_ok=True)
        ext = ".png" if data.startswith(b"\x89PNG") else ".jpg"
        p = cfg.in_dir / (hashlib.sha256(data).hexdigest()[:24] + ext)
        if not p.exists():
            p.write_bytes(data)
        return p
    if "\x00" in value:
        raise ValidationError(f"{key} is not a valid path", key)
    p = Path(value).expanduser()
    try:
        p = p.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ValidationError(f"{key}: no such file", key) from None
    roots = [*cfg.input_roots, cfg.in_dir.resolve(), cfg.out_dir.resolve()]
    if not any(p == r or r in p.parents for r in roots):
        raise ValidationError(f"{key}: path is outside the allowed folders", key)
    if not p.is_file() or p.suffix.lower() not in IMAGE_EXTS:
        raise ValidationError(f"{key}: must be a .png or .jpg file", key)
    if p.stat().st_size > MAX_IMAGE_BYTES:
        raise ValidationError(f"{key}: file is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB", key)
    with p.open("rb") as f:
        if not _sniff(f.read(8)):
            raise ValidationError(f"{key}: not a PNG or JPEG image", key)
    return p


def parse_generate(body: Any, cfg: Config) -> JobSpec:
    b = _obj(body)
    _unknown(b, {"prompt", "negativePrompt", "seed", "n", "width", "height", "model", "controls", "steps"})
    model = _model(b)
    spec = MODELS[model]
    if model != "qwen-cn":
        raise ValidationError(f"model {model} edits an image: use POST /edit", "model")
    prompt = _text(b, "prompt", True)
    assert prompt is not None
    seed = _int(b, "seed", 0, 2**32 - 1)
    n = _int(b, "n", 1, MAX_IMAGES, 1)
    steps = _int(b, "steps", 1, MAX_STEPS, cfg.steps or spec.default_steps)
    width, height = _size(b, spec.default_size, cfg)
    raw = b.get("controls")
    if not isinstance(raw, list) or len(raw) != 1:
        raise ValidationError("qwen-cn takes exactly one control image (the mflux CLI supports a single control)", "controls")
    c = raw[0]
    if not isinstance(c, dict):
        raise ValidationError("controls[0] must be an object", "controls")
    _unknown(c, {"type", "image", "strength"})
    if c.get("type") not in CONTROL_TYPES:
        raise ValidationError(f"controls[0].type must be one of {', '.join(CONTROL_TYPES)}", "controls")
    strength = _num(c.get("strength", 1.0), "controls[0].strength", 0.0, 1.5)
    ctrl = Control(c["type"], resolve_image(c.get("image"), "controls[0].image", cfg), strength)
    return JobSpec("generate", model, prompt, _text(b, "negativePrompt", False), seed, n, width, height, steps, controls=(ctrl,))


def parse_edit(body: Any, cfg: Config) -> JobSpec:
    b = _obj(body)
    _unknown(b, {"image", "prompt", "seed", "strength", "model", "width", "height", "steps", "negativePrompt"})
    model = _model(b)
    spec = MODELS[model]
    if model != "klein-edit":
        raise ValidationError(f"model {model} generates from controls: use POST /generate", "model")
    prompt = _text(b, "prompt", True)
    assert prompt is not None
    seed = _int(b, "seed", 0, 2**32 - 1)
    steps = _int(b, "steps", 1, MAX_STEPS, spec.default_steps)
    strength = _num(b.get("strength", 0.5), "strength", 0.0, 1.0)
    width, height = _size(b, None, cfg)  # default: the source image size
    image = resolve_image(b.get("image"), "image", cfg)
    notes = ("klein-edit has no img2img strength in the mflux CLI: strength is recorded but the prompt decides how much changes",)
    return JobSpec("edit", model, prompt, _text(b, "negativePrompt", False), seed, 1, width, height, steps, image=image, strength=strength, notes=notes)
