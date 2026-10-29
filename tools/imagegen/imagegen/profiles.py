"""Settings profiles of the diffusers (CUDA) backend, and a rough VRAM estimate. Pure Python: no torch needed.

The numbers are ESTIMATES from parameter counts, not measurements: nothing here has run on a GPU yet (the CG2 author
has a Mac). `/health` shows the estimate next to the detected VRAM so a profile that is too big is visible.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from .config import env_get

PRECISIONS = ("bf16", "fp8", "nf4")
OFFLOADS = ("none", "model", "sequential")


@dataclass(frozen=True)
class Settings:
    profile: str
    qwen_precision: str
    qwen_offload: str
    klein_precision: str
    klein_offload: str
    max_side: int
    steps: int  # qwen-cn default
    #: Qwen-Image-Lightning 8-step LoRA on the Qwen-Image base (the diffusers stand-in for Qwen-Image-2.1-Turbo).
    lightning: bool

    def to_json(self) -> dict:
        return {
            "profile": self.profile,
            "qwen": {"precision": self.qwen_precision, "cpuOffload": self.qwen_offload},
            "klein": {"precision": self.klein_precision, "cpuOffload": self.klein_offload},
            "maxSide": self.max_side,
            "steps": self.steps,
            "lightning": self.lightning,
        }


#: name -> (minimum VRAM in GB for auto-selection, settings)
PROFILES: dict[str, tuple[float, Settings]] = {
    "rtx-8gb": (7.0, Settings("rtx-8gb", "nf4", "sequential", "bf16", "sequential", 768, 8, True)),
    "rtx-12gb": (11.0, Settings("rtx-12gb", "nf4", "sequential", "bf16", "model", 1024, 8, True)),
    "rtx-16gb": (15.0, Settings("rtx-16gb", "nf4", "sequential", "bf16", "model", 1280, 8, True)),
    "rtx-24gb": (22.0, Settings("rtx-24gb", "nf4", "model", "bf16", "none", 1536, 8, True)),
    "rtx-48gb": (44.0, Settings("rtx-48gb", "fp8", "model", "bf16", "none", 1536, 8, True)),
    "rtx-80gb": (76.0, Settings("rtx-80gb", "bf16", "none", "bf16", "none", 1536, 8, True)),
}


def pick_profile(vram_gb: float | None) -> str:
    """The largest profile whose minimum fits; the smallest one when the VRAM is unknown or tiny."""
    if vram_gb is None:
        return "rtx-12gb"
    fitting = [(need, name) for name, (need, _) in PROFILES.items() if vram_gb >= need]
    return max(fitting)[1] if fitting else "rtx-8gb"


class SettingsError(ValueError):
    pass


def resolve_settings(env: dict[str, str], vram_gb: float | None) -> Settings:
    """Profile (IMAGEGEN_PROFILE, else PROFILE, else picked from the VRAM) overridden by the individual knobs."""
    name = env_get(env, "IMAGEGEN_PROFILE") or env_get(env, "PROFILE") or pick_profile(vram_gb)
    if name not in PROFILES:
        raise SettingsError(f"unknown profile {name!r}; use one of {', '.join(PROFILES)}")
    s = PROFILES[name][1]
    precision = env_get(env, "IMAGEGEN_PRECISION")
    if precision:
        if precision not in PRECISIONS:
            raise SettingsError(f"IMAGEGEN_PRECISION must be one of {', '.join(PRECISIONS)}")
        s = replace(s, qwen_precision=precision)
    offload = env_get(env, "IMAGEGEN_CPU_OFFLOAD")
    if offload:
        o = offload.lower()
        # true = the lightest offload that is likely to fit; false = none.
        if o == "true":
            o = "model" if s.qwen_offload == "none" else s.qwen_offload
        elif o == "false":
            o = "none"
        if o not in OFFLOADS:
            raise SettingsError("IMAGEGEN_CPU_OFFLOAD must be true, false, model or sequential")
        s = replace(s, qwen_offload=o)
    for key, field_name, lo, hi in (("IMAGEGEN_MAX_SIDE", "max_side", 256, 2048), ("IMAGEGEN_STEPS", "steps", 1, 50)):
        raw = env_get(env, key)
        if raw:
            try:
                v = int(raw)
            except ValueError:
                raise SettingsError(f"{key} must be an integer") from None
            if not lo <= v <= hi:
                raise SettingsError(f"{key} must be between {lo} and {hi}")
            s = replace(s, **{field_name: v})
    lightning = env_get(env, "IMAGEGEN_LIGHTNING")
    if lightning:
        s = replace(s, lightning=lightning.lower() in ("1", "true", "yes", "on"))
    if not s.lightning and not env_get(env, "IMAGEGEN_STEPS"):
        s = replace(s, steps=30)  # the undistilled base needs ~30 steps (and CFG)
    return s


# Component sizes in GB at the stated precision (parameter count x bytes, plus quantisation state). Estimates.
_QWEN_TRANSFORMER = {"bf16": 41.0, "fp8": 21.0, "nf4": 11.5}
_QWEN_TEXT_ENCODER = {"bf16": 16.6, "fp8": 16.6, "nf4": 5.5}  # Qwen2.5-VL-7B; fp8 here only affects the transformer
_QWEN_CONTROLNET = {"bf16": 7.0, "fp8": 7.0, "nf4": 2.0}
_KLEIN = {"transformer": 8.0, "text_encoder": 8.0}  # FLUX.2-klein-4B and its Qwen3-4B encoder in bf16
_CONTEXT = 1.0  # CUDA context, VAE, fragmentation


def _activations(width: int, height: int) -> float:
    return 2.5 * (width * height) / (1024 * 768)


def estimate_peak_gb(model: str, s: Settings, width: int = 1024, height: int = 768) -> float:
    """Rough peak VRAM for one image, in GB (an estimate: see the module note)."""
    act = _activations(width, height)
    if model == "klein-edit":
        kact = act * 0.4  # a 4B transformer: far smaller activations
        off = s.klein_offload
        if off == "none":
            return round(_KLEIN["transformer"] + _KLEIN["text_encoder"] + kact + _CONTEXT, 1)
        if off == "model":
            return round(max(_KLEIN["transformer"] + kact, _KLEIN["text_encoder"] + 0.5) + _CONTEXT, 1)
        return round(1.5 + kact + _CONTEXT, 1)
    p = s.qwen_precision
    tr, te, cn = _QWEN_TRANSFORMER[p], _QWEN_TEXT_ENCODER[p], _QWEN_CONTROLNET[p]
    if s.qwen_offload == "none":
        return round(tr + te + cn + act + _CONTEXT, 1)
    if s.qwen_offload == "model":
        return round(max(tr + cn + act, te + 0.5) + _CONTEXT, 1)
    return round(2.5 + act + _CONTEXT, 1)  # sequential: one layer group at a time


def system_ram_estimate_gb(s: Settings) -> float:
    """System RAM wanted while loading and offloading (the bf16 shards pass through RAM; offloaded weights live there)."""
    resident = _QWEN_TRANSFORMER[s.qwen_precision] + _QWEN_TEXT_ENCODER[s.qwen_precision] + _QWEN_CONTROLNET[s.qwen_precision]
    return round(resident + 8.0, 0)


def fit_report(s: Settings, vram_gb: float | None) -> dict:
    out: dict = {}
    for model in ("qwen-cn", "klein-edit"):
        need = estimate_peak_gb(model, s, min(1024, s.max_side), min(768, s.max_side * 3 // 4))
        fits = None if vram_gb is None else need <= vram_gb * 0.95
        out[model] = {"estimatedPeakGb": need, "fits": fits, "estimate": True}
    out["systemRamGb"] = system_ram_estimate_gb(s)
    warnings = []
    if vram_gb is not None:
        for model, r in out.items():
            if isinstance(r, dict) and r["fits"] is False:
                warnings.append(f"profile {s.profile} for {model} is estimated at {r['estimatedPeakGb']} GB but the GPU has {vram_gb} GB: pick a smaller profile or lower IMAGEGEN_MAX_SIDE")
    out["warnings"] = warnings
    return out
