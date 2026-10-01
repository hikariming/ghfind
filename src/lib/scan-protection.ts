export class ScanBusyError extends Error {
  constructor() {
    super("Score generation is busy; retry shortly");
  }
}

// One in-flight crawl per username, and at most this many cold crawls across
// every isolate. Ninety-six is 24 in-flight scans for each of the four tokens.
// Leases recover capacity after an invocation is killed.
export const SCAN_COLD_CONCURRENCY = 96;
export const ADMIT_SCAN = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[3]) == 1 then return -1 end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return -1 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
redis.call('ZADD', KEYS[2], tonumber(ARGV[2])+tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1`;
export const PUBLISH_SCAN = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
if KEYS[3] then redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[3]) end
return 1`;
export const RELEASE_SCAN = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
 redis.call('DEL', KEYS[1])
 if ARGV[2] == 'failed' then redis.call('SET', KEYS[3], '1', 'EX', 15) end
end
redis.call('ZREM', KEYS[2], ARGV[1])
return 1`;

export const scanTtl = () => 86400 - Math.floor(Math.random() * 7201); // 22–24h

/**
 * The atomic steps protectedScan needs from shared storage. Results keep the
 * Lua scripts' shapes (admit: 1 admitted / 0 wait / -1 busy; publish: 1 when
 * still the owner) so both backends go through the same checks below.
 */
export interface ScanCoordinator {
  admit(owner: string, now: number, leaseMs: number, capacity: number): Promise<unknown>;
  publish(owner: string, payload: string, ttlSeconds: number): Promise<unknown>;
  release(owner: string, failed: boolean): Promise<unknown>;
}

/** Redis coordinator: the original Lua scripts over lock/capacity/cooldown keys. */
function redisScanCoordinator(
  redis: { eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown> },
  keys: string[],
  key: string,
  revisionKey?: string,
): ScanCoordinator {
  return {
    admit: (owner, now, leaseMs, capacity) => redis.eval(ADMIT_SCAN, keys, [owner, now, leaseMs, capacity]),
    publish: (owner, payload, ttlSeconds) =>
      redis.eval(PUBLISH_SCAN, revisionKey ? [keys[0], key, revisionKey] : [keys[0], key], [owner, payload, ttlSeconds]),
    release: (owner, failed) => redis.eval(RELEASE_SCAN, keys, [owner, failed ? "failed" : "ok"]),
  };
}

export async function protectedScan<T>(options: {
  /** Redis backend (Lua scripts). Ignored when `coordinator` is given. */
  redis?: {
    eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>;
  };
  /** Non-Redis backend (the ScanSlot Durable Object in ghfind-coord). */
  coordinator?: ScanCoordinator;
  key: string;
  read: () => Promise<T | null>;
  produce: () => Promise<T>;
  wait?: () => Promise<void>;
  attempts?: number;
  ttl?: (result: T) => number;
  capacityKey?: string;
  revisionKey?: string;
}): Promise<T> {
  const { key, read, produce } = options;
  const keys = [
    `lock:${key}`,
    options.capacityKey ?? "scan:active-producers:v1",
    `cooldown:${key}`,
  ];
  const coordinator =
    options.coordinator ??
    (options.redis ? redisScanCoordinator(options.redis, keys, key, options.revisionKey) : null);
  if (!coordinator) throw new ScanBusyError();
  const owner = crypto.randomUUID();
  const wait =
    options.wait ??
    (() => new Promise<void>((r) => setTimeout(r, 450 + Math.random() * 100)));
  const deadline = Date.now() + 45_000;
  for (let i = 0; i < (options.attempts ?? 90) && Date.now() < deadline; i++) {
    const cached = await read();
    if (cached) return cached;
    let admission: unknown;
    try {
      admission = await coordinator.admit(owner, Date.now(), 300_000, SCAN_COLD_CONCURRENCY);
    } catch {
      throw new ScanBusyError();
    }
    if (typeof admission !== "number") throw new ScanBusyError();
    if (admission < 0) throw new ScanBusyError();
    if (admission === 0) {
      await wait();
      continue;
    }
    let failed = true;
    try {
      // A previous owner may have published between our read and admission.
      const recheck = await read();
      if (recheck) {
        failed = false;
        return recheck;
      }
      const result = await produce();
      // An expired owner must never overwrite a newer producer's snapshot.
      const published = await coordinator.publish(
        owner,
        JSON.stringify(result),
        options.ttl?.(result) ?? scanTtl(),
      );
      if (published !== 1) throw new ScanBusyError();
      failed = false;
      return result;
    } finally {
      // Failure cooldown stops waiters immediately retrying the same bad origin.
      await coordinator.release(owner, failed).catch(() => {});
    }
  }
  // Never turn every timed-out waiter into a new producer.
  throw new ScanBusyError();
}
