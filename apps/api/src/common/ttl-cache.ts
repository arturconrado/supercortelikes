export class TtlCache<T> {
  private readonly values = new Map<string, { expiresAt: number; value: T }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    if (this.ttlMs <= 0) return undefined;
    const item = this.values.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0) return;
    this.values.set(key, { expiresAt: Date.now() + this.ttlMs, value });
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}
