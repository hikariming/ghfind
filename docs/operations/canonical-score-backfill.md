# Canonical score backfill

`POST /api/admin/backfill-scores` processes one bounded keyset page. The route
requires `x-admin-secret` to match `ADMIN_SECRET` and is a dry-run unless the
JSON body contains `"apply": true`.

Applying writes additionally requires `BACKFILL_SCORES_APPLY_ENABLED=1`. Set
`BACKFILL_SCORES_PAUSED=1` to stop both dry-run and apply requests before they
reach storage. Keep the apply switch disabled except during a supervised run.

The body accepts `limit` from 1 through 100 and an opaque `cursor` returned by
the previous response. Offset pagination is rejected. Responses contain only
aggregate counters and the next opaque cursor; the storage implementation must
not encode account identifiers in that cursor.

Each first-page request fixes a completion-time watermark. Continue with the
returned cursor until `nextCursor` is `null`, then start again with a null cursor
to pick up runs that completed after that watermark. A failed write returns a
cursor before the failed row, so retrying that cursor cannot skip the row.
