"""CUDA backend: diffusers pipelines kept resident in this process, one model at a time.

NOT RUN ON A GPU YET. It was written against diffusers 0.42.1 (class names and signatures checked in the wheel) but the
author's machine is a Mac. Treat the first run on the RTX as the test; `python -m imagegen preflight` is the first step.

qwen-cn    Qwen/Qwen-Image + InstantX/Qwen-Image-ControlNet-Union (QwenImageControlNetPipeline) with the Qwen-Image-Lightning
           8-step LoRA. The mflux backend uses Qwen-Image-2.1-Turbo + Fun-Controlnet-Union, which diffusers cannot load.
klein-edit Flux2KleinPipeline with a source image (the same model as the mflux backend).
"""

from __future__ import annotations

import gc
import time
from typing import Any

from .config import Config
from .jobs import Cancelled, ImageResult, Job
from .models import DIFFUSERS_KLEIN, DIFFUSERS_QWEN_BASE, DIFFUSERS_QWEN_CONTROLNET, DIFFUSERS_QWEN_LIGHTNING, DIFFUSERS_QWEN_LIGHTNING_FILE
from .profiles import Settings


class PreflightError(RuntimeError):
    pass


def preflight() -> dict[str, Any]:
    """Checks that torch sees a GPU and that its kernels run on it (Blackwell RTX 50xx is sm_120: needs torch >= 2.7 cu128)."""
    try:
        import torch
    except ImportError as e:
        raise PreflightError("torch is not installed: this backend needs the `cuda` extra (uv sync --extra cuda) or the Docker image") from e
    if not torch.cuda.is_available():
        raise PreflightError(
            "torch.cuda.is_available() is False. In Docker: start with `docker compose up` (GPU reservation) or `--gpus all`, "
            "and check `nvidia-smi` works inside the container. On Windows: NVIDIA driver with WSL support + Docker Desktop WSL2 backend."
        )
    major, minor = torch.cuda.get_device_capability(0)
    arch = f"sm_{major}{minor}"
    archs = torch.cuda.get_arch_list()
    has_binary = arch in archs
    has_ptx = any(a.startswith("compute_") and int(a.split("_")[1]) <= int(f"{major}{minor}") for a in archs)
    if not has_binary and not has_ptx:
        raise PreflightError(
            f"this torch build ({torch.__version__}, CUDA {torch.version.cuda}) has no kernels for the GPU's {arch} (it ships {', '.join(archs)}). "
            "RTX 50-series (Blackwell, sm_120) needs torch >= 2.7 with the cu128 wheels."
        )
    try:
        x = torch.randn(64, 64, device="cuda", dtype=torch.bfloat16)
        (x @ x).sum().item()
    except Exception as e:  # noqa: BLE001
        raise PreflightError(f"a test kernel failed on the GPU ({arch}): {e}") from e
    props = torch.cuda.get_device_properties(0)
    return {
        "name": props.name,
        "vramGb": round(props.total_memory / 1e9, 1),
        "capability": arch,
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "kernels": "binary" if has_binary else "ptx-jit (slower first start)",
    }


def _bnb_config() -> dict:
    import torch

    return {"load_in_4bit": True, "bnb_4bit_quant_type": "nf4", "bnb_4bit_compute_dtype": torch.bfloat16, "bnb_4bit_use_double_quant": True}


def _fp8(module: Any) -> None:
    import torch

    module.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16)


def _place(pipe: Any, offload: str) -> None:
    if offload == "model":
        pipe.enable_model_cpu_offload()
    elif offload == "sequential":
        pipe.enable_sequential_cpu_offload()
    else:
        pipe.to("cuda")


def _fit_size(src_w: int, src_h: int, max_side: int) -> tuple[int, int]:
    scale = min(1.0, max_side / max(src_w, src_h))
    return max(256, int(src_w * scale) // 32 * 32), max(256, int(src_h * scale) // 32 * 32)


class DiffusersRunner:
    def __init__(self, cfg: Config, settings: Settings, log=print) -> None:  # noqa: ANN001
        self.cfg = cfg
        self.s = settings
        self.log = log
        self._name: str | None = None
        self._pipe: Any = None
        self.lightning_active = settings.lightning

    # -- loading -------------------------------------------------------------------------------------------------
    def _unload(self) -> None:
        self._pipe, self._name = None, None
        gc.collect()
        import torch

        torch.cuda.empty_cache()

    def _load_qwen(self) -> Any:
        import torch
        from diffusers import QwenImageControlNetModel, QwenImageControlNetPipeline
        from diffusers.quantizers import PipelineQuantizationConfig

        s = self.s
        quant = None
        cn_kwargs: dict[str, Any] = {"torch_dtype": torch.bfloat16}
        if s.qwen_precision == "nf4":
            quant = PipelineQuantizationConfig(quant_backend="bitsandbytes_4bit", quant_kwargs=_bnb_config(), components_to_quantize=["transformer", "text_encoder"])
            from diffusers import BitsAndBytesConfig

            cn_kwargs["quantization_config"] = BitsAndBytesConfig(**_bnb_config())
        controlnet = QwenImageControlNetModel.from_pretrained(DIFFUSERS_QWEN_CONTROLNET, **cn_kwargs)
        pipe = QwenImageControlNetPipeline.from_pretrained(DIFFUSERS_QWEN_BASE, controlnet=controlnet, torch_dtype=torch.bfloat16, **({"quantization_config": quant} if quant else {}))
        if s.qwen_precision == "fp8":
            _fp8(pipe.transformer)
            _fp8(pipe.controlnet)
        if self.lightning_active:
            try:
                pipe.load_lora_weights(DIFFUSERS_QWEN_LIGHTNING, weight_name=DIFFUSERS_QWEN_LIGHTNING_FILE)
            except Exception as e:  # noqa: BLE001
                self.log(f"[imagegen] Lightning LoRA failed to load ({e}); falling back to the undistilled base (30 steps, CFG 4)")
                self.lightning_active = False
        _place(pipe, s.qwen_offload)
        pipe.vae.enable_tiling()
        pipe.vae.enable_slicing()
        return pipe

    def _load_klein(self) -> Any:
        import torch
        from diffusers import Flux2KleinPipeline

        pipe = Flux2KleinPipeline.from_pretrained(DIFFUSERS_KLEIN, torch_dtype=torch.bfloat16)
        if self.s.klein_precision == "fp8":
            _fp8(pipe.transformer)
        _place(pipe, self.s.klein_offload)
        pipe.vae.enable_tiling()
        return pipe

    def _get(self, model: str) -> Any:
        if self._name != model:
            self._unload()
            self.log(f"[imagegen] loading {model} ({self.s.profile}) ...")
            t = time.time()
            self._pipe = self._load_qwen() if model == "qwen-cn" else self._load_klein()
            self._name = model
            self.log(f"[imagegen] {model} ready in {time.time() - t:.0f}s")
        return self._pipe

    # -- running -------------------------------------------------------------------------------------------------
    def run(self, job: Job) -> None:
        import torch
        from PIL import Image

        spec = job.spec
        self.cfg.out_dir.mkdir(parents=True, exist_ok=True)
        pipe = self._get(spec.model)
        steps = spec.steps
        if spec.model == "qwen-cn" and not self.lightning_active and steps == 8:  # LoRA missing: the undistilled base needs ~30
            steps = 30
        for i in range(spec.n):
            if job.cancel.is_set():
                raise Cancelled
            seed = spec.seed + i
            t0 = time.time()
            torch.cuda.reset_peak_memory_stats()

            def on_step(_pipe, step, _t, kwargs, i=i):  # noqa: ANN001
                if job.cancel.is_set():
                    raise Cancelled
                job.progress = (i + (step + 1) / steps) / spec.n
                return kwargs

            gen = torch.Generator("cpu").manual_seed(seed)  # cpu: the same noise whatever the offload/VRAM
            if spec.kind == "generate":
                c = spec.controls[0]
                ctrl = Image.open(c.path).convert("RGB")
                out = pipe(
                    prompt=spec.prompt,
                    negative_prompt=spec.negative_prompt or " ",
                    true_cfg_scale=1.0 if self.lightning_active else 4.0,
                    control_image=ctrl,
                    controlnet_conditioning_scale=c.strength,
                    width=spec.width,
                    height=spec.height,
                    num_inference_steps=steps,
                    generator=gen,
                    callback_on_step_end=on_step,
                ).images[0]
            else:
                assert spec.image is not None
                src = Image.open(spec.image).convert("RGB")
                w, h = (spec.width, spec.height) if spec.width and spec.height else _fit_size(src.width, src.height, self.s.max_side)
                out = pipe(image=src, prompt=spec.prompt, width=w, height=h, num_inference_steps=steps, guidance_scale=1.0, generator=gen, callback_on_step_end=on_step).images[0]
            path = self.cfg.out_dir / f"{job.id}-s{seed}.png"
            out.save(path)
            peak = round(torch.cuda.max_memory_allocated() / 1e9, 1)
            job.images.append(ImageResult(str(path), seed, time.time() - t0, peak))
            job.progress = (i + 1) / spec.n
