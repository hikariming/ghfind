-- Official, operator-granted tags (e.g. "dsh内测用户"). These carry GHFind
-- authority and render as gold badges, unlike the derived `tags` field.
ALTER TABLE talent_profiles ADD COLUMN official_tags_json TEXT;
