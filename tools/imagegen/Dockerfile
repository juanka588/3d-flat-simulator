# Image sidecar, CUDA backend (diffusers). For an NVIDIA GPU on Linux or Windows (Docker Desktop + WSL2).
# On a Mac use the native mflux backend instead (Docker cannot reach the Metal GPU): `pnpm imagegen:setup`.
#
#   docker build -t flat-imagegen tools/imagegen            (linux/amd64 only: the torch cu128 wheels)
#   docker compose -f tools/imagegen/compose.yaml up
#
# CUDA 12.8 is the first release with Blackwell (RTX 50xx, sm_120) support; torch 2.8.0 from PyPI ships cu128 wheels with
# sm_120 kernels and bundles its own CUDA libraries, so the base only has to provide the driver interface and libcudart.
FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04

COPY --from=ghcr.io/astral-sh/uv:0.9.18 /uv /usr/local/bin/uv

ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Dependencies first (cached until pyproject.toml / uv.lock change).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --extra cuda --extra clip

COPY imagegen ./imagegen

# Non-root user; /models (Hugging Face cache) and /data (outputs, input uploads) are volumes.
RUN useradd --create-home --uid 10001 imagegen \
    && mkdir -p /models /data \
    && chown -R imagegen:imagegen /models /data
USER imagegen

ENV PATH=/opt/venv/bin:$PATH \
    HF_HOME=/models \
    HF_HUB_DISABLE_TELEMETRY=1 \
    IMAGEGEN_BACKEND=diffusers \
    IMAGEGEN_HF_HOME=/models \
    IMAGEGEN_OUT=/data/out \
    IMAGEGEN_INPUT_ROOTS=/data \
    IMAGEGEN_BIND=0.0.0.0 \
    IMAGEGEN_PORT=8790
VOLUME ["/models", "/data"]
EXPOSE 8790

# Never prints the token; /health needs it when IMAGEGEN_TOKEN is set.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python -c "import os,sys,urllib.request as u; t=os.environ.get('IMAGEGEN_TOKEN'); r=u.Request('http://127.0.0.1:8790/health', headers={'Authorization': 'Bearer '+t} if t else {}); sys.exit(0 if u.urlopen(r, timeout=4).status==200 else 1)"

ENTRYPOINT ["python", "-m", "imagegen"]
CMD ["serve"]
