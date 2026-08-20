import { describe, it, expect } from 'vitest';
import { SchedulerService } from '../../src/server/scheduler.js';

describe('SchedulerService', () => {
  it('sleep resolves after roughly the requested delay', async () => {
    const s = new SchedulerService();
    const start = Date.now();
    await s.sleep(40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
    s.dispose();
  });

  it('after runs the callback once and can be cancelled', async () => {
    const s = new SchedulerService();
    let ran = 0;
    s.after(20, () => (ran += 1));
    const cancel = s.after(20, () => (ran += 10));
    cancel();
    await s.sleep(60);
    expect(ran).toBe(1);
    s.dispose();
  });

  it('waitUntil resolves true when the condition becomes true', async () => {
    const s = new SchedulerService();
    let flag = false;
    s.after(30, () => (flag = true));
    const met = await s.waitUntil(() => flag, { intervalMs: 10, timeoutMs: 500 });
    expect(met).toBe(true);
    s.dispose();
  });

  it('waitUntil resolves false on timeout', async () => {
    const s = new SchedulerService();
    const met = await s.waitUntil(() => false, { intervalMs: 10, timeoutMs: 50 });
    expect(met).toBe(false);
    s.dispose();
  });

  it('cancelOwner clears an owner\u2019s pending timers', async () => {
    const s = new SchedulerService();
    let ran = 0;
    s.after(20, () => (ran += 1), 'projX');
    s.after(20, () => (ran += 1), 'projX');
    s.cancelOwner('projX');
    await s.sleep(60);
    expect(ran).toBe(0);
    s.dispose();
  });
});
