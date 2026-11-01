-- Optional repository-owned AI provider configuration. Plaintext API keys are
-- never stored. encrypted_key contains versioned AES-GCM ciphertext and nonce;
-- its authenticated data binds repository, owner, provider and canonical URL.
CREATE TABLE ai_providers (
  repository INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('platform','byok')),
  provider TEXT NOT NULL CHECK(provider IN ('llm','jev')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  encrypted_key TEXT,
  updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
