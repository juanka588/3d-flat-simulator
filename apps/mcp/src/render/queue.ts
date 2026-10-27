/** Raised when the queue already holds `maxDepth` jobs (running + waiting). */
export class QueueBusyError extends Error {
  constructor(public readonly depth: number) {
    super(`render queue is full (${depth} renders in flight)`);
    this.name = 'QueueBusyError';
  }
}

/**
 * Serialised job queue (a mutex with a bounded line): one job runs at a time, in arrival order; a job
 * that arrives while `maxDepth` jobs are already in flight (running + waiting) is rejected at once.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private inFlight = 0;

  constructor(private readonly maxDepth = 3) {}

  get depth(): number {
    return this.inFlight;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxDepth) return Promise.reject(new QueueBusyError(this.inFlight));
    this.inFlight += 1;
    const result = this.tail.then(() => job());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.inFlight -= 1;
    });
  }
}
