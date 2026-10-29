"""Jobs and the strict FIFO queue: one worker thread, one job at a time (a generation peaks at 38 GB on a 64 GB Mac)."""

from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Protocol

from .validate import JobSpec


@dataclass
class ImageResult:
    path: str
    seed: int
    seconds: float
    peak_gb: float | None
    #: Wall seconds before the first denoising step (model load, text encoding): the cost the resident backend avoids.
    load_s: float | None = None
    #: Seconds spent in the denoising steps themselves.
    steps_s: float | None = None

    def to_json(self) -> dict:
        d: dict = {"path": self.path, "seed": self.seed, "seconds": round(self.seconds, 1), "peakGb": self.peak_gb}
        if self.load_s is not None:
            d["loadS"] = round(self.load_s, 1)
        if self.steps_s is not None:
            d["stepsS"] = round(self.steps_s, 1)
        return d


class Cancelled(Exception):
    pass


@dataclass
class Job:
    id: str
    spec: JobSpec
    status: str = "queued"  # queued | running | done | error | cancelled
    progress: float = 0.0
    images: list[ImageResult] = field(default_factory=list)
    error: str | None = None
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    #: Things the runner noticed while running (memory headroom, slow phases); shown in the job JSON.
    warnings: list[str] = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)
    #: set by the runner so `cancel` can stop a running process
    kill: Callable[[], None] | None = None

    def to_json(self, position: int | None = None) -> dict:
        d: dict = {
            "jobId": self.id,
            "status": self.status,
            "progress": round(self.progress, 3),
            "images": [i.to_json() for i in self.images],
        }
        if self.spec.notes:
            d["notes"] = list(self.spec.notes)
        if self.warnings:
            d["warnings"] = list(self.warnings)
        t = self.timings()
        if t:
            d["timings"] = t
        if position is not None:
            d["queuePosition"] = position
        if self.error:
            d["error"] = self.error
        return d


    def timings(self) -> dict | None:
        """Wall times of the job: waiting in the queue, running, and the sums of the per-image load and step times."""
        if self.started is None:
            return None
        end = self.finished or time.time()
        d: dict = {"queuedS": round(self.started - self.created, 1), "runS": round(end - self.started, 1)}
        loads = [i.load_s for i in self.images if i.load_s is not None]
        steps = [i.steps_s for i in self.images if i.steps_s is not None]
        if loads:
            d["loadS"] = round(sum(loads), 1)
        if steps:
            d["stepsS"] = round(sum(steps), 1)
        return d


class Runner(Protocol):
    def run(self, job: Job) -> None:
        """Fill `job.images` and `job.progress`; raise `Cancelled` when `job.cancel` is set; any other exception is the job error."""

    # Optional (the queue uses getattr): `resident() -> str | None` names the model held in memory between jobs, `unload()` frees it.


class JobQueue:
    KEEP_FINISHED = 100

    def __init__(self, runner: Runner, unload_after: float | None = None) -> None:
        """`unload_after`: None keeps the model resident; 0 frees it when a job ends and nothing else is queued; N > 0 frees it after N idle seconds."""
        self._runner = runner
        self._unload_after = unload_after
        self._idle_since = time.monotonic()
        self.last_job: dict | None = None
        self.unloads = 0
        self._cv = threading.Condition()
        self._fifo: deque[str] = deque()
        self._jobs: dict[str, Job] = {}
        self._finished: deque[str] = deque()
        self._stopped = False
        self._thread = threading.Thread(target=self._loop, name="imagegen-worker", daemon=True)
        self._thread.start()

    def submit(self, spec: JobSpec) -> Job:
        job = Job(id=uuid.uuid4().hex[:16], spec=spec)
        with self._cv:
            self._jobs[job.id] = job
            self._fifo.append(job.id)
            self._cv.notify()
        return job

    def get(self, job_id: str) -> tuple[Job, int | None] | None:
        with self._cv:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            pos = list(self._fifo).index(job_id) if job_id in self._fifo else None
            return job, pos

    def cancel(self, job_id: str) -> Job | None:
        """Queued: removed. Running: the process is stopped. Finished: forgotten."""
        with self._cv:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.status == "queued":
                self._fifo.remove(job_id)
                job.status = "cancelled"
                self._retire(job)
            elif job.status == "running":
                job.cancel.set()
                if job.kill:
                    job.kill()
            else:
                self._jobs.pop(job_id, None)
            return job

    def stats(self) -> dict:
        with self._cv:
            running = [j.id for j in self._jobs.values() if j.status == "running"]
            return {"queued": len(self._fifo), "running": running[0] if running else None}

    def stop(self) -> None:
        with self._cv:
            self._stopped = True
            for j in self._jobs.values():
                if j.status == "running":
                    j.cancel.set()
                    if j.kill:
                        j.kill()
            self._cv.notify_all()

    def _retire(self, job: Job) -> None:
        self._finished.append(job.id)
        while len(self._finished) > self.KEEP_FINISHED:
            self._jobs.pop(self._finished.popleft(), None)

    def resident(self) -> str | None:
        fn = getattr(self._runner, "resident", None)
        return fn() if fn else None

    def _unload(self) -> None:
        fn = getattr(self._runner, "unload", None)
        if fn is None or self.resident() is None:
            return
        try:
            fn()
            self.unloads += 1
        except Exception:  # noqa: BLE001 - freeing memory must never kill the worker
            pass

    def _idle_wait(self) -> float | None:
        """Seconds until the idle unload is due; None: nothing to wait for."""
        if not self._unload_after or self.resident() is None:
            return None
        return max(0.01, self._unload_after - (time.monotonic() - self._idle_since))

    def _loop(self) -> None:
        while True:
            idle_unload = False
            with self._cv:
                while not self._fifo and not self._stopped:
                    wait = self._idle_wait()
                    woken = self._cv.wait(wait)
                    if wait is not None and not woken and not self._fifo and not self._stopped:
                        idle_unload = True
                        break
                if self._stopped:
                    return
                if not idle_unload:
                    job = self._jobs[self._fifo.popleft()]
                    job.status = "running"
                    job.started = time.time()
            if idle_unload:
                self._unload()
                continue
            try:
                self._runner.run(job)
                status, error = "done", None
            except Cancelled:
                status, error = "cancelled", None
            except Exception as e:  # noqa: BLE001 - the job reports any failure
                status, error = "error", str(e)[-1500:] or e.__class__.__name__
            with self._cv:
                job.finished = time.time()
                job.status, job.error = status, error
                if status == "done":
                    job.progress = 1.0
                self.last_job = {"jobId": job.id, "model": job.spec.model, "status": status, "images": len(job.images), **(job.timings() or {})}
                self._retire(job)
                more = bool(self._fifo)
            self._idle_since = time.monotonic()
            if self._unload_after == 0 and not more:
                self._unload()
