# Score cache protection / 评分缓存保护

The public score API caches indexed account details for 22–24 hours. Cache hits avoid
database reads; on misses, an owner-token Redis lease serializes database repopulation.
Missing records are cached for 10 seconds so publication is not hidden for a full day.
Cold GitHub scans use the same admission mechanism with a separate global capacity pool.

- One lease holder per normalized username and collection/score version.
- At most eight active cold crawls, plus a separate maximum of eight indexed-detail reads.
- Followers wait up to approximately 45 seconds for cached results, then receive
  `503 scan_busy` with `Retry-After: 15`; they never independently fall through to GitHub.
- Redis admission failures fail closed. Local development without Redis still works.
- Cache writes and release use owner-checked Lua, so an expired producer cannot overwrite
  a newer cache entry or release someone else's lease.
- Leases expire after five minutes to recover from terminated workers. Work must stay
  inside that lease; publication after expiry fails rather than overwriting new data.
- A failed producer imposes a 15-second cooldown; 22–24h TTL jitter spreads expiration.
- API overload responses are `no-store`. Normal cached reads remain available during
  capacity pressure. This bounds origin concurrency; it is not a claim of unlimited load.

Run `pnpm exec vitest run src/lib/__tests__/scan-protection.test.ts` for failure cases.
For real Redis concurrency, start a disposable Redis on `127.0.0.1:16389`, then run
`pnpm exec tsx scripts/smoke-scan-protection.mts`. The script uses a random key prefix and
cleans only its own keys. It exercises 50 concurrent same-handle requests, 30 different
handles and an expired lock owner against the actual Lua scripts.

公开评分接口优先读取 22–24 小时缓存；未命中时在互斥锁下查询数据库并回填，
不存在的账号只缓存 10 秒。首次 GitHub 评分也需要分布式准入，同一账号只有一个持锁者。
不同账号的冷评分全局最多 8 个并发，数据库回填使用独立的 8 并发池。
等待约 45 秒仍未拿到结果时返回 503 和 15 秒重试提示，不再直接回源。
Redis 故障时停止新的生产回源；失败冷却和随机过期减少重复失败及集中失效。
锁过期后恢复容量，旧持锁者不能覆盖新缓存或删除新锁。
