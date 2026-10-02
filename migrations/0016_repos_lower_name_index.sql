-- Repo typeahead (searchRepos) prefix-matches lower(name); without this index
-- every keystroke scanned the whole repos table.
CREATE INDEX IF NOT EXISTS idx_repos_lower_name ON repos(lower(name));
