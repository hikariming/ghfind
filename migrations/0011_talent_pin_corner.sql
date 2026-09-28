-- Operator pinning floats a talent to the top of the directory; corner_tag
-- renders a gold triangular ribbon on the card's top-right corner (e.g.
-- "找实习") to flag a contact-seeking status.
ALTER TABLE talent_profiles ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE talent_profiles ADD COLUMN corner_tag TEXT;
