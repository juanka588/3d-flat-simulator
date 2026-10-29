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

    def to_json(self) -> dict:
        return {"path": self.path, "seed": self.seed, "seconds": round(self.seconds, 1), "peakGb": self.peak_gb}


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
        if position is not None:
            d["queuePosition"] = position
        if self.error:
            d["error"] = self.error
        return d


class Runner(Protocol):
    def run(self, job: Job) -> None:
        """Fill `job.images` and `job.progress`; raise `Cancelled` when `job.cancel` is set; any other exception is the job error."""


class JobQueue:
    KEEP_FINISHED = 100

    def __init__(self, runner: Runner) -> None:
        self._runner = runner
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

    def _loop(self) -> None:
        while True:
            with self._cv:
                while not self._fifo and not self._stopped:
                    self._cv.wait()
                if self._stopped:
                    return
                job = self._jobs[self._fifo.popleft()]
                job.status = "running"
            try:
                self._runner.run(job)
                status, error = "done", None
            except Cancelled:
                status, error = "cancelled", None
            except Exception as e:  # noqa: BLE001 - the job reports any failure
                status, error = "error", str(e)[-1500:] or e.__class__.__name__
            with self._cv:
                job.status, job.error = status, error
                if status == "done":
                    job.progress = 1.0
                self._retire(job)
