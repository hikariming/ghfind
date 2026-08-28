ALTER TABLE feed.projects
  ADD COLUMN base_descriptor TEXT NOT NULL DEFAULT '';

UPDATE feed.projects SET base_descriptor=descriptor WHERE base_descriptor='';
