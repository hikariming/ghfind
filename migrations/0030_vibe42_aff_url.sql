-- Vibe42 asked for their affiliate link in place of the UTM link from 0029.
UPDATE sponsorships
SET sponsor_url = 'https://vibe42.ai/?aff=GHFIND',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'sponsor-vibe42';
