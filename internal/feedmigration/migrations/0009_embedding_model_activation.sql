CREATE TABLE feed.embedding_model_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  active_model TEXT NOT NULL DEFAULT '',
  building_model TEXT NOT NULL DEFAULT '',
  activated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO feed.embedding_model_state(singleton) VALUES (true)
ON CONFLICT(singleton) DO NOTHING;
