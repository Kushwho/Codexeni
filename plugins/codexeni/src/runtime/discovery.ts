/**
 * Short-lived cache for expensive harness probes only — jobs, roots, and circuit
 * breakers stay live in the BridgeRuntime response, never cached here.
 */
export class DiscoveryCache<T> {
  private readonly cached = new Map<string, { value: T; expiresAtMs: number }>();
  private readonly pending = new Map<string, Promise<T>>();

  public constructor(
    private readonly nowMs: () => number,
    private readonly ttlMs: number,
  ) {}

  public clear(key: string): void {
    this.cached.delete(key);
    this.pending.delete(key);
  }

  public async get(key: string, refresh: boolean, load: () => Promise<T>): Promise<T> {
    const cached = this.cached.get(key);
    if (!refresh && cached && cached.expiresAtMs > this.nowMs()) return cached.value;
    const pending = this.pending.get(key);
    if (pending) return pending;

    const probe = load();
    this.pending.set(key, probe);
    try {
      const value = await probe;
      this.cached.set(key, { value, expiresAtMs: this.nowMs() + this.ttlMs });
      return value;
    } finally {
      this.pending.delete(key);
    }
  }
}
