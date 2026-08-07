export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  increment(name: string, labels: Record<string, string> = {}, value = 1) {
    const suffix = Object.entries(labels).sort().map(([key, item]) => `${key}=${JSON.stringify(item)}`).join(",");
    const key = suffix ? `${name}{${suffix}}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }
  render(): string {
    return [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key} ${value}`).join("\n") + "\n";
  }
}
