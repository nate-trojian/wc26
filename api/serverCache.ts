type CacheEntry<T> = {
  expiresAt: number;
  value?: T;
  pending?: Promise<T>;
};

const cache = new Map<string, CacheEntry<unknown>>();

function nowMs() {
  return Date.now();
}

export function cacheTtlMs(envName: string, defaultMs: number) {
  const configured = process.env[envName];
  if (!configured) {
    return defaultMs;
  }

  if (configured.toLowerCase() === "infinity") {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number.parseInt(configured, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultMs;
}

export async function readThroughCache<T>(key: string, ttlMs: number, loader: () => Promise<T>) {
  if (ttlMs <= 0) {
    return loader();
  }

  const cached = cache.get(key) as CacheEntry<T> | undefined;
  const now = nowMs();
  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  if (cached?.pending) {
    return cached.pending;
  }

  const pending = loader()
    .then((value) => {
      cache.set(key, { value, expiresAt: nowMs() + ttlMs });
      return value;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });

  cache.set(key, { pending, expiresAt: now + ttlMs });
  return pending;
}

export function writeThroughCache<T>(key: string, value: T, ttlMs: number) {
  if (ttlMs <= 0) {
    cache.delete(key);
    return;
  }

  cache.set(key, { value, expiresAt: nowMs() + ttlMs });
}

export function clearCache(key: string) {
  cache.delete(key);
}
