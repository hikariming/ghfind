-- Talent directory i18n: per-locale content overrides. Chinese stays in the
-- original columns (source of truth); this JSON column holds overlays like
-- {"en": {"role": "...", "direction": "...", "bio": "...", "note": "...",
-- "project_description": "..."}} and missing fields fall back to Chinese.
ALTER TABLE talent_profiles ADD COLUMN content_i18n_json TEXT;
