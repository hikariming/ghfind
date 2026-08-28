ALTER TABLE feed.event_outbox
  ADD COLUMN dedupe_key TEXT,
  ADD COLUMN locked_by TEXT,
  ADD COLUMN locked_until TIMESTAMPTZ;

CREATE UNIQUE INDEX event_outbox_dedupe_key
  ON feed.event_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX event_outbox_relay_ready
  ON feed.event_outbox (available_at, id)
  WHERE delivered_at IS NULL;
