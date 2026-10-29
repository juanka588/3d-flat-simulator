"""The HTTP surface: stdlib only, bound to 127.0.0.1, Host and Origin checked like the scene server."""

from __future__ import annotations

import hmac
import json
import os
import re
from pathlib import Path
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import __version__
from .config import Config
from .clip import ClipError, ClipService, MAX_TOP_K, SOURCES, mask_from_ids, prepare_crop
from .jobs import JobQueue
from .memstat import headroom_warning, read_memory
from .models import MODELS, downloaded
from .validate import ValidationError, parse_edit, parse_generate, resolve_image

LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
JOB_PATH = re.compile(r"^/jobs/([0-9a-f]{16})$")
IMAGE_PATH = re.compile(r"^/jobs/([0-9a-f]{16})/images/([0-3])$")


def host_allowed(host: str | None, extra: tuple[str, ...] = ()) -> bool:
    """The Host header must name this machine (blocks DNS rebinding) or a configured address; absent (HTTP/1.0) is allowed."""
    if not host:
        return True
    name = host[: host.index("]") + 1] if host.startswith("[") else host.split(":")[0]
    return name.lower() in LOCAL_HOSTS or name.lower() in {h.lower() for h in extra}


def token_ok(header: str | None, token: str | None) -> bool:
    """No token configured: open (loopback only). Otherwise `Authorization: Bearer <token>`, compared in constant time."""
    if not token:
        return True
    return bool(header) and header.startswith("Bearer ") and hmac.compare_digest(header[7:].encode(), token.encode())


def origin_allowed(origin: str | None, allowed: tuple[str, ...]) -> bool:
    """Browsers send Origin on cross-site requests; no Origin means not a browser (the MCP, curl)."""
    return origin is None or origin in allowed


def thumbnail(path: Path, max_side: int) -> tuple[bytes, str]:
    """A JPEG (quality 82) no larger than `max_side` on its long edge: what the MCP hands to the model."""
    if not 64 <= max_side <= 2048:
        raise ValueError("maxSide out of range")
    import io

    from PIL import Image

    with Image.open(path) as im:
        im = im.convert("RGB")
        im.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=82)
        return buf.getvalue(), "image/jpeg"


def memory_gb() -> float | None:
    try:
        return round(os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / 1e9, 1)
    except (ValueError, OSError, AttributeError):
        return None


def mflux_version() -> str | None:
    try:
        from importlib.metadata import version

        return version("mflux")
    except Exception:  # noqa: BLE001
        return None


def unload_policy(cfg: Config) -> str:
    if cfg.unload_after is None:
        return "never (the model stays resident between jobs)" if cfg.backend == "diffusers" else "never needed (mflux runs one process per image: nothing stays resident)"
    return "after each job" if cfg.unload_after == 0 else f"after {cfg.unload_after:g} s idle"


def health(cfg: Config, queue: JobQueue, info: dict[str, Any] | None = None, clip: ClipService | None = None, mem: dict[str, Any] | None = None) -> dict[str, Any]:
    """`info` is what the backend learned at start-up: gpu, settings, fit, loaded() (diffusers only)."""
    info = info or {}
    stats = queue.stats()
    running = queue.get(stats["running"]) if stats["running"] else None
    active = info["loaded"]() if "loaded" in info else (running[0].spec.model if running else None)
    lightning = info.get("settings", {}).get("lightning", True)
    out: dict[str, Any] = {
        "ready": True,
        "version": __version__,
        "backend": cfg.backend,
        "mflux": mflux_version() if cfg.backend == "mflux" else None,
        "models": [
            {
                "id": m.id,
                "downloaded": downloaded(cfg.hf_home, m.id, cfg.backend, lightning),
                "loaded": m.id == active,
                "sizeGb": m.size_gb if cfg.backend == "mflux" else m.diffusers_size_gb,
                "licence": m.licence,
            }
            for m in MODELS.values()
        ],
        "memGb": memory_gb(),
        "memory": mem if mem is not None else read_memory(),
        "resident": resident_report(cfg, queue, running[0].spec.model if running else None),
        "unload": unload_policy(cfg),
        "lastJob": queue.last_job,
        "maxSide": cfg.max_side,
        "queue": stats,
        "downloadsAllowed": cfg.allow_download,
    }
    for key in ("gpu", "settings", "fit", "warnings"):
        if key in info:
            out[key] = info[key]
    if clip is not None:
        out["clip"] = clip.status()
    return out


def resident_report(cfg: Config, queue: JobQueue, running_model: str | None) -> dict[str, Any]:
    """What the sidecar holds in memory right now. At most one generation model: mflux has a process per image (so only while a job
    runs), diffusers frees the other model before loading one. `estGb` is the measured peak of that model."""
    model = queue.resident() or running_model
    return {"models": [model] if model else [], "estGb": MODELS[model].peak_gb if model else 0.0, "holdsBetweenJobs": queue.resident() is not None}


def _open(path: Path) -> Any:
    from PIL import Image

    im = Image.open(path)
    im.load()
    return im


def make_server(cfg: Config, queue: JobQueue, info: dict[str, Any] | None = None, clip: ClipService | None = None, aesthetic: Any = None) -> ThreadingHTTPServer:
    from .aesthetic import AestheticScorer

    clip = clip or ClipService(cfg, allow_download=cfg.allow_download)
    aesthetic = aesthetic or AestheticScorer(cfg, allow_download=cfg.allow_download)

    def image_path(value: Any, key: str) -> Path:
        """A path / base64 (resolve_image) or `{jobId, index}` of a finished job of this sidecar."""
        if isinstance(value, dict):
            job_id, index = value.get("jobId"), value.get("index", 0)
            found = queue.get(job_id) if isinstance(job_id, str) else None
            if not found or not isinstance(index, int) or not 0 <= index < len(found[0].images):
                raise ValidationError(f"{key}: no such job image", key)
            return Path(found[0].images[index].path)
        return resolve_image(value, key, cfg)

    def box_of(value: Any) -> tuple[int, int, int, int] | None:
        if value is None:
            return None
        if not (isinstance(value, list) and len(value) == 4 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in value)):
            raise ValidationError("box must be [x0, y0, x1, y1] in pixels", "box")
        x0, y0, x1, y1 = (int(round(v)) for v in value)
        if x1 <= x0 or y1 <= y0:
            raise ValidationError("box must have x1 > x0 and y1 > y0", "box")
        return x0, y0, x1, y1

    def do_embed(b: dict[str, Any]) -> dict[str, Any]:
        for k in b:
            if k not in ("images", "texts"):
                raise ValidationError(f"unknown field {k}", k)
        images, texts = b.get("images") or [], b.get("texts") or []
        if not isinstance(images, list) or not isinstance(texts, list) or not all(isinstance(t, str) and 0 < len(t) <= 300 for t in texts):
            raise ValidationError("images and texts must be lists (texts: strings of 1 to 300 characters)")
        pics = [prepare_crop(_open(image_path(v, f"images[{i}]"))) for i, v in enumerate(images)]
        return clip.embed(pics, texts)

    def do_aesthetic(b: dict[str, Any]) -> dict[str, Any]:
        for k in b:
            if k != "images":
                raise ValidationError(f"unknown field {k}", k)
        images = b.get("images")
        if not isinstance(images, list) or not 1 <= len(images) <= 8:
            raise ValidationError("images must be a list of 1 to 8 images", "images")
        pics = [_open(image_path(v, f"images[{i}]")).convert("RGB") for i, v in enumerate(images)]
        with clip._lock:
            return aesthetic.score(pics)

    def do_build(b: dict[str, Any]) -> dict[str, Any]:
        for k in b:
            if k != "source":
                raise ValidationError(f"unknown field {k}", k)
        src = b.get("source")
        if src not in SOURCES:
            raise ValidationError(f"source must be one of {', '.join(SOURCES)}", "source")
        return clip.build(src)

    def do_query(b: dict[str, Any]) -> dict[str, Any]:
        for k in b:
            if k not in ("image", "box", "mask", "maskColor", "background", "text", "topK", "source", "filters"):
                raise ValidationError(f"unknown field {k}", k)
        top_k = b.get("topK", 5)
        if not isinstance(top_k, int) or isinstance(top_k, bool) or not 1 <= top_k <= MAX_TOP_K:
            raise ValidationError(f"topK must be an integer from 1 to {MAX_TOP_K}", "topK")
        src = b.get("source", "all")
        if src not in (*SOURCES, "all"):
            raise ValidationError("source must be catalog, hd or all", "source")
        f = b.get("filters") or {}
        if not isinstance(f, dict) or set(f) - {"category", "maxPrice"}:
            raise ValidationError("filters accepts category and maxPrice", "filters")
        cat, mp = f.get("category"), f.get("maxPrice")
        if cat is not None and not isinstance(cat, str):
            raise ValidationError("filters.category must be a string", "filters")
        if mp is not None and (not isinstance(mp, (int, float)) or isinstance(mp, bool) or mp < 0):
            raise ValidationError("filters.maxPrice must be a number >= 0", "filters")
        text = b.get("text")
        if text is not None and (not isinstance(text, str) or not 0 < len(text) <= 300):
            raise ValidationError("text must be a string of 1 to 300 characters", "text")
        if b.get("image") is None and text is None:
            raise ValidationError("give image (with box) or text", "image")
        bg = b.get("background", "plain")
        if bg not in ("plain", "border"):
            raise ValidationError("background must be plain or border", "background")
        vecs: list[list[float]] = []
        mode = []
        if b.get("image") is not None:
            im = _open(image_path(b["image"], "image"))
            mask = None
            if b.get("mask") is not None:
                col = b.get("maskColor")
                if col is not None and not (isinstance(col, list) and len(col) == 3 and all(isinstance(c, int) and 0 <= c <= 255 for c in col)):
                    raise ValidationError("maskColor must be [r, g, b] integers", "maskColor")
                mask = mask_from_ids(_open(image_path(b["mask"], "mask")), tuple(col) if col else None)
                mode.append("mask")
            crop = prepare_crop(im, box_of(b.get("box")), mask, bg)
            if bg == "border" and mask is None:
                mode.append("border")
            vecs.extend(clip.embed([crop], [])["images"])
        if text is not None:
            vecs.extend(clip.embed([], [text])["texts"])
        q = [sum(v[i] for v in vecs) / len(vecs) for i in range(len(vecs[0]))]
        out = clip.query(q, top_k, list(SOURCES) if src == "all" else [src], cat, mp)
        return {**out, "prep": mode or ["plain"]}

    ROUTES = {"/embed": do_embed, "/aesthetic": do_aesthetic, "/index/build": do_build, "/index/query": do_query}

    class Handler(BaseHTTPRequestHandler):
        server_version = "flat-imagegen"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # one line per request on stderr
            if os.environ.get("IMAGEGEN_QUIET"):
                return
            os.write(2, (f"[imagegen] {self.command} {self.path.split('?')[0]} {fmt % args}\n").encode())

        # -- plumbing ------------------------------------------------------------------------------------------
        def _send(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _err(self, status: int, code: str, message: str, field: str = "") -> None:
            self._send(status, {"ok": False, "code": code, "message": message, **({"field": field} if field else {})})

        def _guard(self) -> bool:
            if not host_allowed(self.headers.get("Host"), cfg.allowed_hosts):
                self._err(403, "forbidden", "host not allowed")
                return False
            if not origin_allowed(self.headers.get("Origin"), cfg.allowed_origins):
                self._err(403, "forbidden", "origin not allowed")
                return False
            if not token_ok(self.headers.get("Authorization"), cfg.token):
                self._err(401, "unauthorized", "missing or wrong bearer token")
                return False
            return True

        def _body(self) -> Any:
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                raise ValidationError("Content-Type must be application/json")
            try:
                length = int(self.headers.get("Content-Length") or "")
            except ValueError:
                raise ValidationError("Content-Length is required") from None
            if length < 0 or length > cfg.max_body_bytes:
                raise ValidationError(f"body is larger than {cfg.max_body_bytes} bytes")
            try:
                return json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise ValidationError("body is not valid JSON") from None

        # -- routes --------------------------------------------------------------------------------------------
        def do_GET(self) -> None:  # noqa: N802
            if not self._guard():
                return
            path = self.path.split("?")[0]
            if path == "/health":
                return self._send(200, health(cfg, queue, info, clip))
            im = IMAGE_PATH.match(path)
            if im:
                return self._image(im.group(1), int(im.group(2)), self.path.partition("?")[2])
            m = JOB_PATH.match(path)
            if m:
                found = queue.get(m.group(1))
                if not found:
                    return self._err(404, "not_found", "no such job")
                return self._send(200, found[0].to_json(found[1]))
            self._err(404, "not_found", "no such route")

        def _image(self, job_id: str, index: int, query: str = "") -> None:
            found = queue.get(job_id)
            if not found or index >= len(found[0].images):
                return self._err(404, "not_found", "no such image")
            path = Path(found[0].images[index].path).resolve()
            if cfg.out_dir.resolve() not in path.parents or not path.is_file():
                return self._err(404, "not_found", "image file is gone")
            ctype = "image/png"
            max_side = parse_qs(query).get("maxSide", [""])[0]
            if max_side:
                try:
                    data, ctype = thumbnail(path, int(max_side))
                except ValueError:
                    return self._err(400, "invalid_request", "maxSide must be an integer between 64 and 2048", "maxSide")
                except ImportError:
                    return self._err(501, "not_implemented", "Pillow is not installed: thumbnails are unavailable")
            else:
                data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:  # noqa: N802
            if not self._guard():
                return
            path = self.path.split("?")[0]
            if path in ROUTES:
                try:
                    body = self._body()
                    if not isinstance(body, dict):
                        raise ValidationError("body must be a JSON object")
                    return self._send(200, {"ok": True, **ROUTES[path](body)})
                except ValidationError as e:
                    return self._err(400, "invalid_request", str(e), e.field)
                except ClipError as e:
                    return self._err(e.status, e.code, str(e), e.field)
                except ImportError as e:
                    return self._err(501, "not_implemented", f"missing dependency: {e}")
            if path not in ("/generate", "/edit"):
                return self._err(404, "not_found", "no such route")
            try:
                body = self._body()
                spec = parse_generate(body, cfg) if path == "/generate" else parse_edit(body, cfg)
                if not downloaded(cfg.hf_home, spec.model, cfg.backend, (info or {}).get("settings", {}).get("lightning", True)) and not cfg.allow_download:
                    return self._err(409, "model_missing", f"model {spec.model} is not in the cache {cfg.hf_home}; run `pnpm imagegen:setup --download` or set IMAGEGEN_HF_HOME")
            except ValidationError as e:
                return self._err(400, "invalid_request", str(e), e.field)
            job = queue.submit(spec)
            self._send(202, {"jobId": job.id})

        def do_DELETE(self) -> None:  # noqa: N802
            if not self._guard():
                return
            m = JOB_PATH.match(self.path.split("?")[0])
            if not m:
                return self._err(404, "not_found", "no such route")
            job = queue.cancel(m.group(1))
            if not job:
                return self._err(404, "not_found", "no such job")
            self._send(200, {"jobId": job.id, "status": job.status})

        def do_PUT(self) -> None:  # noqa: N802
            self._err(405, "method_not_allowed", "method not allowed")

        do_PATCH = do_PUT  # noqa: N815

    return ThreadingHTTPServer((cfg.host, cfg.port), Handler)
