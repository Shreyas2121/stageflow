// Active counters are never evicted to admit fresh identities.
export class WindowBudget {
  private readonly entries = new Map<string, { count: number; expires: number }>();
  private sweepAt = 0;
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
    private readonly now = () => performance.now(),
  ) {}
  consume(key: string): boolean {
    const now = this.now();
    if (now >= this.sweepAt) {
      for (const [key, value] of this.entries) if (value.expires <= now) this.entries.delete(key);
      this.sweepAt = now + this.windowMs;
    }
    let entry = this.entries.get(key);
    if (entry && entry.expires <= now) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (this.entries.size >= this.maxKeys) return false;
      entry = { count: 0, expires: now + this.windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }
}
