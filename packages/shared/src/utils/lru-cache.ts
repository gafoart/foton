/**
 * LRU cache with eviction callback.
 * Uses a Map for insertion-order iteration (oldest first when evicting).
 */
export class LRUCache<K, V> {
  private map = new Map<K, V>();
  private readonly maxSize: number;
  private readonly onEvict?: (key: K, value: V) => void;
  /** If false, that entry is skipped when picking the LRU victim (next oldest is tried; if all false, oldest is evicted). */
  private readonly canEvictKey?: (key: K) => boolean;

  constructor(options: {
    maxSize: number;
    onEvict?: (key: K, value: V) => void;
    canEvictKey?: (key: K) => boolean;
  }) {
    this.maxSize = options.maxSize;
    this.onEvict = options.onEvict;
    this.canEvictKey = options.canEvictKey;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const victim = this.pickEvictionVictim();
      if (victim !== undefined) {
        const victimValue = this.map.get(victim)!;
        this.map.delete(victim);
        this.onEvict?.(victim, victimValue);
      }
    }
    this.map.set(key, value);
  }

  private pickEvictionVictim(): K | undefined {
    if (this.map.size === 0) return undefined;
    const order = [...this.map.keys()];
    const allow = this.canEvictKey;
    if (!allow) return order[0];
    for (const k of order) {
      if (allow(k)) return k;
    }
    return order[0];
  }

  delete(key: K): boolean {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.onEvict?.(key, value);
      return true;
    }
    return false;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}
