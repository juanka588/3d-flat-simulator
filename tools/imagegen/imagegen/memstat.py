"""Memory facts for /health and the job log: what the machine can give a generation right now.

Why: a Qwen-Image + ControlNet job peaks at ~38 GB. On a 64 GB Mac that also runs headless Chromium, the MCP server, the scene
server and a Claude session, the second real close-the-gap run swapped (10.6 GB of swap, 7.2 M swap-outs) and one 90 s image took
30 min. The numbers below let the runner (and a human) see that before it happens. Parsers are pure functions of the tools'
text output so they can be tested; the readers shell out with a short timeout and never raise.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from typing import Any

GB = 1e9


def parse_vm_stat(text: str) -> dict[str, float]:
    """`vm_stat` -> GB of {free, inactive, speculative, purgeable, active, wired, compressed}."""
    m = re.search(r"page size of (\d+) bytes", text)
    page = int(m.group(1)) if m else 16384
    names = {"free": "Pages free", "inactive": "Pages inactive", "speculative": "Pages speculative", "purgeable": "Pages purgeable", "active": "Pages active", "wired": "Pages wired down", "compressed": "Pages occupied by compressor"}
    out: dict[str, float] = {}
    for key, label in names.items():
        mm = re.search(rf"^{re.escape(label)}:\s+(\d+)\.", text, re.M)
        if mm:
            out[key] = int(mm.group(1)) * page / GB
    return out


def parse_swapusage(text: str) -> dict[str, float]:
    """`sysctl -n vm.swapusage` -> GB of {total, used, free}. Units are M or G."""
    out: dict[str, float] = {}
    for key in ("total", "used", "free"):
        m = re.search(rf"{key} = ([\d.]+)([MGK])", text)
        if m:
            out[key] = float(m.group(1)) * {"K": 1e3, "M": 1e6, "G": 1e9}[m.group(2)] / GB
    return out


PRESSURE = {1: "normal", 2: "warn", 4: "critical"}


def _run(argv: list[str]) -> str:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=3, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _linux() -> dict[str, Any]:
    try:
        kv = {}
        for line in open("/proc/meminfo").read().splitlines():
            k, _, v = line.partition(":")
            kv[k] = int(v.split()[0]) * 1024 / GB
        return {"totalGb": round(kv["MemTotal"], 1), "availableGb": round(kv.get("MemAvailable", kv["MemFree"]), 1), "swapUsedGb": round(kv.get("SwapTotal", 0) - kv.get("SwapFree", 0), 1), "pressure": "unknown"}
    except (OSError, KeyError, ValueError):
        return {}


def read_memory() -> dict[str, Any]:
    """{totalGb, availableGb (free + inactive + speculative + purgeable: what a new allocation can take without paging), swapUsedGb, pressure}. {} when unknown."""
    if sys.platform != "darwin":
        return _linux() if sys.platform.startswith("linux") else {}
    vm = parse_vm_stat(_run(["vm_stat"]))
    if not vm:
        return {}
    swap = parse_swapusage(_run(["sysctl", "-n", "vm.swapusage"]))
    level = _run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"]).strip()
    try:
        total = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / GB
    except (ValueError, OSError):
        total = 0.0
    available = vm.get("free", 0) + vm.get("inactive", 0) + vm.get("speculative", 0) + vm.get("purgeable", 0)
    return {
        "totalGb": round(total, 1),
        "availableGb": round(available, 1),
        "freeGb": round(vm.get("free", 0), 1),
        "swapUsedGb": round(swap.get("used", 0), 1),
        "pressure": PRESSURE.get(int(level) if level.isdigit() else 0, "unknown"),
    }


def headroom_warning(mem: dict[str, Any], need_gb: float) -> str | None:
    """A sentence when `need_gb` (the model's peak) does not fit without paging, else None."""
    if not mem or "availableGb" not in mem:
        return None
    avail = mem["availableGb"]
    swap = mem.get("swapUsedGb", 0) or 0
    pressure = mem.get("pressure", "unknown")
    if avail < need_gb:
        return f"only {avail:.0f} GB of memory can be taken without paging but the model peaks at ~{need_gb:.0f} GB (swap used {swap:.1f} GB, pressure {pressure}): expect it to swap and run many times slower; close other apps or the headless browsers first"
    if pressure in ("warn", "critical"):
        return f"memory pressure is {pressure} (available {avail:.0f} GB, swap used {swap:.1f} GB, model peak ~{need_gb:.0f} GB): expect slowdowns"
    return None
