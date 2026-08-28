-- Local-compose bootstrap only. Production/Railway operators must execute the
-- same extension activation once with a privileged database role; the
-- ghfind-feed-migrate binary deliberately verifies but never installs it.
CREATE EXTENSION IF NOT EXISTS vector;
-- Gorse v0.5.11 otherwise attempts to install this on startup. Keep extension
-- installation in the privileged, one-time database bootstrap instead of
-- granting the Gorse runtime role elevated database privileges.
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Local Compose mirrors production's trust boundary: Gorse gets a distinct
-- login that may create only its prefixed tables in public. The feed schema is
-- created and owned later by the migration role, so this login has no rights
-- to read Feed business facts.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gorse_local') THEN
        CREATE ROLE gorse_local LOGIN PASSWORD 'gorse-local-only';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE ghfind_feed TO gorse_local;
GRANT USAGE, CREATE ON SCHEMA public TO gorse_local;
