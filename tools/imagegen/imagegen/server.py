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
from .jobs import JobQueue
from .models import MODELS, downloaded
from .validate import ValidationError, parse_edit, parse_generate

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


def health(cfg: Config, queue: JobQueue, info: dict[str, Any] | None = None) -> dict[str, Any]:
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
        "maxSide": cfg.max_side,
        "queue": stats,
        "downloadsAllowed": cfg.allow_download,
    }
    for key in ("gpu", "settings", "fit", "warnings"):
        if key in info:
            out[key] = info[key]
    return out


def make_server(cfg: Config, queue: JobQueue, info: dict[str, Any] | None = None) -> ThreadingHTTPServer:
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
                return self._send(200, health(cfg, queue, info))
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
