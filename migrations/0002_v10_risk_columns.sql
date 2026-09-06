-- v10 structured public-risk evidence. Both columns are nullable so existing
-- score rows remain readable while the bounded backfill upgrades them.
ALTER TABLE scores ADD COLUMN risk_assessment TEXT;
ALTER TABLE scores ADD COLUMN risk_notes TEXT;
