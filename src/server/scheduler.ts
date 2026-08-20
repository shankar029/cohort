/**
 * A small scheduling service so agents (and the orchestrator) can wait for
 * events, poll for conditions, and retry after a delay — the timing primitives a
 * real engineer reaches for. All timers are tracked for clean shutdown and are
 * unref'd so they never keep the process alive on their own.
 */
export type Cancel = () => void;

export class SchedulerService {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly byOwner = new Map<string, Set<ReturnType<typeof setTimeout>>>();

  private track(t: ReturnType<typeof setTimeout>, owner?: string): void {
    t.unref?.();
    this.timers.add(t);
    if (owner) {
      let set = this.byOwner.get(owner);
      if (!set) {
        set = new Set();
        this.byOwner.set(owner, set);
      }
      set.add(t);
    }
  }

  private untrack(t: ReturnType<typeof setTimeout>, owner?: string): void {
    this.timers.delete(t);
    if (owner) this.byOwner.get(owner)?.delete(t);
  }

  /** Resolve after `ms` milliseconds. */
  sleep(ms: number, owner?: string): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(
        () => {
          this.untrack(t, owner);
          resolve();
        },
        Math.max(0, ms),
      );
      this.track(t, owner);
    });
  }

  /** Run `fn` once after `ms`; returns a cancel handle. */
  after(ms: number, fn: () => void, owner?: string): Cancel {
    const t = setTimeout(
      () => {
        this.untrack(t, owner);
        try {
          fn();
        } catch {
          /* swallow: a scheduled callback must not crash the process */
        }
      },
      Math.max(0, ms),
    );
    this.track(t, owner);
    return () => {
      clearTimeout(t);
      this.untrack(t, owner);
    };
  }

  /**
   * Poll `predicate` every `intervalMs` until it returns true or `timeoutMs`
   * elapses. Resolves true if the condition was met, false on timeout.
   */
  async waitUntil(
    predicate: () => boolean | Promise<boolean>,
    opts: { intervalMs?: number; timeoutMs?: number; owner?: string } = {},
  ): Promise<boolean> {
    const intervalMs = Math.max(10, opts.intervalMs ?? 500);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    // Immediate first check.
    if (await predicate()) return true;
    while (Date.now() < deadline) {
      await this.sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), opts.owner);
      if (await predicate()) return true;
    }
    return false;
  }

  /** Cancel every timer created for `owner` (e.g. when a project is removed). */
  cancelOwner(owner: string): void {
    const set = this.byOwner.get(owner);
    if (!set) return;
    for (const t of set) {
      clearTimeout(t);
      this.timers.delete(t);
    }
    this.byOwner.delete(owner);
  }

  /** Clear all timers (server shutdown). */
  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.byOwner.clear();
  }
}
