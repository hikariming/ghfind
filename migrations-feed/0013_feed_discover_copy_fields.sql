-- Additive Discover card copy fields (schema only). Does not rescore or republish.
-- DDL only, so it applies under the 0012 writer fence. The partition tag seed
-- lives in 0015 and needs an operator run in production (docs/operations/feed-0015-partition-tags-operator.md).
-- Empty strings mean "legacy projection"; readers fall back to summary / client hook strip.
ALTER TABLE feed_projects ADD COLUMN discover_hook TEXT NOT NULL DEFAULT '';
ALTER TABLE feed_projects ADD COLUMN pain_statement TEXT NOT NULL DEFAULT '';
ALTER TABLE feed_projects ADD COLUMN audience_primary TEXT NOT NULL DEFAULT '';
