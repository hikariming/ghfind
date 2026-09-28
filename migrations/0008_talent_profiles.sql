-- Talent directory (人才库). Editorial records are seeded from
-- content/collections; intake submissions land as status='pending' and are
-- never listed until an operator publishes them.
CREATE TABLE talent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT,
  role TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT '未分类',
  bio TEXT NOT NULL DEFAULT '',
  skills_json TEXT NOT NULL DEFAULT '[]',
  stars INTEGER,
  contributions INTEGER,
  source TEXT NOT NULL DEFAULT '人工整理',
  project TEXT NOT NULL DEFAULT '',
  project_description TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  available INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT 'sage',
  tags_json TEXT,
  projects_json TEXT,
  sources_json TEXT,
  public_fields_json TEXT,
  collection_slug TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('published', 'pending')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_talent_profiles_status_sort
  ON talent_profiles(status, sort_order, created_at DESC);
