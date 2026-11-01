-- Operator-supplied avatar for talent profiles without a GitHub account (or to
-- override the GitHub one). Absolute https URL, typically an object in the
-- ghfind-assets R2 bucket served from assets.ghfind.com. NULL falls back to the
-- GitHub avatar, then initials.
ALTER TABLE talent_profiles ADD COLUMN avatar_url TEXT;
