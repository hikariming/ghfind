-- Personal API tokens get scopes. Every existing token keeps only `scan`;
-- managing the ghfind Review bot needs a token created with the `bot` scope.
-- Stored as a space-separated list. Additive: code reading this column treats
-- a database without it as scan-only, so the column may land before or after
-- the Workers that read it.
ALTER TABLE ghfind_api_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'scan';
