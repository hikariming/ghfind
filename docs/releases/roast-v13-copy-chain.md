# Roast v13 copy chain (flagged)

Only roast copy changes. Scores, score/roast/collection versions and the release
manifest are untouched; `ROAST_CACHE_VERSION` stays `v12` and the Go prompt port
keeps parity with it.

## Why

v12 asks one streaming call to emit control lines plus a full markdown report
with "fact + jab" rows for every dimension. In practice that produced:

- cross-account boilerplate (PR-state and contribution-calendar disclaimers in
  nearly every report, a recurring metaphor family);
- filler jabs that carry neither a fact nor a punchline;
- number dumps and hedges;
- occasional wrong attributions (a star count attached to the wrong repository).

## What changes (only when `ROAST_GENERATOR=v13`)

`src/lib/roast-v13/` runs three short non-streaming calls:

1. **angles** (temp 0.4, optional) picks 6–8 account-specific tensions with
   exact numbers, applying a swap test ("would this read the same for another
   account?").
2. **writer** (temp 0.9) writes structured JSON from a compact fact card:
   title, three roast-line candidates, tags, verdict, three findings, one line
   per dimension, risk and advice. One retry on unusable JSON.
3. **editor** (temp 0.3) fact-checks against the full slim payload plus the
   deterministic issue list, deletes filler and clichés, picks the best line.
   Editor failure keeps the draft.

`validate.ts` then checks every number, repository name and repo/star pairing
against the payload and drops sentences that still cite unknown facts.
`render.ts` renders the markdown deterministically: score, tier and the
dimension table come from the scan, never from the model. The existing identity,
strong-core and output sanitizers and the led/co-maintained project appendix
still run on the result.

## Budgets and fallback

- chain budget 140 s from request start, 60 s per step; the v12 stream keeps the
  remaining budget inside the existing 220 s LLM deadline;
- any chain failure streams the v12 single call instead (same roast release, so
  it persists normally; logged as `generator: "v12_fallback"`);
- BYO-key requests always use v12;
- `roast.summary` logs `generator`, per-step ms / chars, estimated tokens and
  fact-check issue counts.

## Versioning

The generator is an implementation detail of roast release `v12`: reports stay
stored and cached under `ROAST_CACHE_VERSION`, so flipping the flag never marks
existing reports stale and TS/Go readers keep agreeing. Accounts get v13 copy
when a roast is generated (first roast, manual 重新评测, score-rescan follow-up).
Turning the flag off simply returns new generations to v12.

## Latency and where it runs

The chain is three sequential calls (≈60–140 s on a thinking model), slower
than the v12 single stream. `ROAST_V13_SCOPE` chooses where it runs:

- `all` (default): interactive and queued roasts; the stream shows stage
  progress (挑选事实 → 撰写 → 核对) and the first content arrives when the chain
  finishes;
- `background`: only queued auto re-roast jobs (#566 cron drain, no viewer
  waiting); interactive roasts keep the faster v12 call.

Recommended production path: a follow-up roast release bump (`v12 → v13` in the
manifest, TS + Go) with `ROAST_GENERATOR=v13 ROAST_V13_SCOPE=background`. The
#566 on-view queue then shows the previous report labelled 旧版锐评 immediately
and replaces it with chain copy in the background (rate-limited, no bulk
re-roast).

## Rollout

1. Staging: set plain vars `ROAST_GENERATOR=v13` (scope `all`) and compare.
2. Optional: `ROAST_V13_LLM_API_KEY` / `ROAST_V13_LLM_BASE_URL` /
   `ROAST_V13_LLM_MODEL` to run the chain on a dedicated model; otherwise it uses
   the default provider with the existing fallback.
3. Watch `roast.summary` for `v12_fallback` rate and `v13ChainMs`.
4. Production: `ROAST_V13_SCOPE=background` plus the separate release bump PR.

Mosoo is not on the serving path. Upstream mosoo (`langgenius/mosoo`,
`runtime-subject-record-store.ts` on main, Oct 2026) enforces a per-account
concurrent sandbox limit (`ACCOUNT_CONCURRENT_SANDBOX_LIMIT`, currently 5) plus
a deployment-wide ceiling (50). A turn that needs a new sandbox at the limit
fails at once with retryable `runtime.capacity_exhausted`; nothing queues, and
an idle sandbox is reclaimed only after a 5-minute grace unless the thread is
archived. That account budget is shared with project analysis. A Mosoo writer
can be added later as an optional background producer with
archive-after-output and a reserved-slot setting read from config (never a
hard-coded count), falling back to this chain on `capacity_exhausted`.
