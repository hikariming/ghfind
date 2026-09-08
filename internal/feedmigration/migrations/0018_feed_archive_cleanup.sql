CREATE TABLE feed.archive_objects (
 object_key TEXT PRIMARY KEY,
 github_id BIGINT NOT NULL,
 profile_version BIGINT NOT NULL,
 payload_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','stored','erased')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 erased_at TIMESTAMPTZ
);
CREATE INDEX feed_archive_actor_version ON feed.archive_objects(github_id,profile_version,object_key) WHERE status<>'erased';
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN portable_cleanup BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN cleanup_phase TEXT NOT NULL DEFAULT 'primary' CHECK(cleanup_phase IN ('primary','archive','semantic','completed'));
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN cleanup_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN cleanup_lease_owner TEXT;
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN cleanup_lease_until TIMESTAMPTZ;
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN cleanup_available_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX feed_cleanup_pending ON feed.user_deletion_tombstones(cleanup_available_at,requested_at) WHERE portable_cleanup AND cleanup_status IN ('queued','running');
