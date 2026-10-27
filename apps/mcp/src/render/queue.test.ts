import { describe, expect, it } from 'vitest';
import { QueueBusyError, SerialQueue } from './queue';

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((ok) => (open = ok));
  return { p, open };
};

describe('render queue', () => {
  it('runs jobs one at a time, in order', async () => {
    const q = new SerialQueue(3);
    const log: string[] = [];
    const g1 = gate();
    const a = q.run(async () => {
      log.push('a start');
      await g1.p;
      log.push('a end');
    });
    const b = q.run(async () => void log.push('b'));
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(['a start']);
    g1.open();
    await Promise.all([a, b]);
    expect(log).toEqual(['a start', 'a end', 'b']);
    expect(q.depth).toBe(0);
  });

  it('rejects the job beyond depth 3 as busy, and recovers', async () => {
    const q = new SerialQueue(3);
    const g = gate();
    const jobs = [1, 2, 3].map(() => q.run(() => g.p));
    await expect(q.run(async () => 1)).rejects.toBeInstanceOf(QueueBusyError);
    expect(q.depth).toBe(3);
    g.open();
    await Promise.all(jobs);
    await expect(q.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('a failing job does not block the next one', async () => {
    const q = new SerialQueue(3);
    const a = q.run(async () => {
      throw new Error('boom');
    });
    const b = q.run(async () => 'fine');
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('fine');
  });
});
