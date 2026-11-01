# Curated X timeline (/feed)

The `/feed` stream shows X posts only from curated voices, so technical
readers see the work, not engagement farming. ghfind never crawls X: an
operator agent pushes posts, and the server decides what is kept.

## Who gets in

1. **Editorial allowlist** — `src/config/x-accounts.ts`: researchers, builders /
   CEOs, tech media. Changing it is a reviewed PR. Removing an entry drops that
   account's stored posts on the next ingest.
2. **Score gate** — any account sent with a `github` login whose ghfind score is
   `>= 80` (`X_MIN_DEV_SCORE`). Re-checked every time the account is sent;
   falling below the bar removes the account and its posts.

Linking an account to a GitHub login (or `talentId`) connects it to that
person's developer / talent card: the score badge, the "Lately on X" block,
follows, and the comment thread are shared.

## What gets in (per post)

| Rule | Reason code |
| --- | --- |
| account admitted (above) | `unknown_account` |
| `kind` is `post`, `quote` or `thread` (no replies, no reposts) | `not_original` |
| posted within 21 days | `too_old` |
| `technical >= 0.6` and at least one topic | `low_technical` |
| 40+ characters of text, or media / a quoted link | `too_short` |
| not engagement bait ("like & RT", giveaways, airdrops, >4 hashtags, 关注我/转发抽奖…) | `engagement_bait` |

The stored window keeps at most 4 posts per account and 240 overall, newest
first, dropping near-duplicate text. Sending a stored post again refreshes its
X metrics.

`technical` (0–1) and `topics` come from the agent's classifier: score how much
the post is about building, research results, engineering, products, or
technical analysis; score memes, politics, personal life and promotion low.

## API

`POST /api/internal/x-timeline` (legacy Next Worker; `?dryRun=1` validates
without writing). Auth: `x-admin-secret: $ADMIN_SECRET` or
`Authorization: Bearer $ADMIN_SECRET`. Body up to 512 KB, 50 accounts and 200
posts per call.

```json
{
  "accounts": [
    { "handle": "karpathy", "name": "Andrej Karpathy", "verified": true,
      "avatarUrl": "https://pbs.twimg.com/profile_images/…", "github": "karpathy" }
  ],
  "posts": [
    {
      "id": "1849000000000000000",
      "handle": "karpathy",
      "text": "exact post text, unedited",
      "createdAt": "2026-10-24T08:00:00Z",
      "url": "https://x.com/karpathy/status/1849000000000000000",
      "kind": "post",
      "metrics": { "likes": 1200, "reposts": 180, "replies": 64, "views": 210000 },
      "media": { "url": "https://pbs.twimg.com/media/….jpg", "alt": "chart" },
      "quote": { "author": "…", "text": "…", "url": "https://…" },
      "topics": ["LLM", "tokenizers"],
      "technical": 0.9,
      "lang": "en",
      "translations": { "zh": "…", "ja": "…", "ar": "…" }
    }
  ]
}
```

Response: `{ accepted, updated, rejected: [{ id, reason }], refusedAccounts, stored, dryRun }`.

- `GET /api/internal/x-timeline` — stored counts and last update.
- `DELETE /api/internal/x-timeline?id=<postId>` or `?handle=<handle>` — moderation.

`translations` is optional: the agent's translation of the post into any site
locale (`zh en ja ko es pt id vi ar`). Readers whose locale differs from the
post's `lang` get a "Show translation" toggle (on by default in the detail
view, and in grid tiles), labelled as agent-translated; the original text is
always one tap away.

Only `pbs.twimg.com` media and avatar URLs are kept; post links always point to
`x.com`. Post text is shown exactly as written, with the author, a link to the
original, and X's own metrics.

## Storage

One KV document (`x-timeline:v1`, 30-day TTL) in the deployment's
`GHFIND_CACHE` namespace. Dev and production namespaces are separate, so
pushing to dev never touches production. No D1 migration.

## Pushing from a file

```sh
GHFIND_BASE_URL=https://dev.ghfind.com GHFIND_ADMIN_SECRET=… \
  pnpm tsx scripts/x-timeline-push.mts batch.json [--dry-run]
```

Recommended cadence: every 30–60 minutes, the last few posts of each
curated account plus metric refreshes for posts already stored.
