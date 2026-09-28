ALTER TABLE author_subscriptions ADD COLUMN source TEXT NOT NULL DEFAULT 'verified' CHECK(source IN ('verified','public'));
CREATE TABLE author_email_optouts (
 user_id INTEGER PRIMARY KEY,
 updated INTEGER NOT NULL
);
-- Preserve known historical opt-outs whose encrypted subscription was deleted.
INSERT OR IGNORE INTO author_email_optouts(user_id,updated)
SELECT user_id,MAX(updated) FROM author_emails
WHERE NOT EXISTS(SELECT 1 FROM author_subscriptions s WHERE s.user_id=author_emails.user_id)
GROUP BY user_id;
