# Feed 0015: Discover partition tag seed (operator runbook, owner sign-off required)

Status: **executed in production 2026-10-23 (owner-approved)** via the fallback batch below; recorded in `d1_migrations` and listed in `ops/feed-production-schema-release.json`.

## Why this is not a normal migration
`migrations-feed/0015_feed_discover_partition_tags.sql` inserts 4 canonical rows into
`feed_tag_definitions` (`use_case:ai-agent`, `use_case:agent-skill`, `artifact:microservice`,
`artifact:sandbox`). In production the 0012 legacy-writer fence is enabled
(`feed_adapter_write_fence.enabled=1`). Its `BEFORE INSERT ON feed_tag_definitions` trigger aborts
any DML that does not run inside the adapter's write context, so `wrangler d1 migrations apply` would
fail on this file. That is why 0015 was applied by this runbook and only then listed in
`ops/feed-production-schema-release.json` (already recorded as applied, so `migrations apply` skips it). Local, CI and portable profiles still apply 0015 normally.

## Effect if not run
None for the public site. Projections that carry these 4 tags create `feed_tag_proposals`
(status `proposed`) instead of attaching canonical tags. This is the current production
behaviour.

## Preconditions
1. The owner approves this runbook (date and approver recorded in the release notes).
2. The production Feed deploy is green and `feed_projects` has the 0013 columns
   (`SELECT name FROM pragma_table_info('feed_projects') WHERE name IN ('discover_hook','pain_statement','audience_primary')`
   returns 3 rows).
3. Read-only pre-check, which should return 13 rows and none of the 4 ids:
   `SELECT id FROM feed_tag_definitions ORDER BY id;`

## Preferred path: governed taxonomy command
If the Feed operator/governance API exposes canonical tag creation, create the 4 tags through it.
That path runs inside the adapter write context and is audited (`feed_governance_commands`).
Use the ids, labels and descriptions from the 0015 file verbatim.

## Fallback path: one atomic D1 batch (owner runs it)
The adapter's write context is a single row that exists only inside one atomic batch. Emulating it
is an operator action and must be one transaction. All three statements run in a single
`wrangler d1 execute --file` (a single batch):

```sql
INSERT INTO feed_adapter_write_context(id, token) VALUES (1, '<fresh uuid v4>');
-- paste the INSERT OR IGNORE INTO feed_tag_definitions ... statement from 0015 verbatim
DELETE FROM feed_adapter_write_context WHERE id = 1;
```

Then record the migration so that later `migrations apply` runs skip it:
`INSERT INTO d1_migrations(name, applied_at) VALUES ('0015_feed_discover_partition_tags.sql', CURRENT_TIMESTAMP);`
(`d1_migrations` is not fenced.) Only after that, add 0015 to the production schema release
manifest in a PR.

## Verification (read-only)
- `SELECT COUNT(*) FROM feed_tag_definitions` returns 17.
- `SELECT COUNT(*) FROM feed_adapter_write_context` returns 0. **If it is 1, delete that row
  immediately. Otherwise the fence is effectively off.**
- `SELECT enabled FROM feed_adapter_write_fence` still returns 1.

## Rollback
Within the same write-context batch pattern:
`DELETE FROM feed_tag_definitions WHERE id IN ('use_case:ai-agent','use_case:agent-skill','artifact:microservice','artifact:sandbox') AND NOT EXISTS (SELECT 1 FROM feed_project_tags t WHERE t.tag_id = feed_tag_definitions.id);`
Also delete the `d1_migrations` row for 0015. Tags already attached to projects must be detached by
the governance path first. No assessment data is touched either way.
