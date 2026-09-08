-- The compatibility range is an explicit migration decision, not a guess based
-- on the number of installed files. Keep it unchanged for additive v1 releases.
CREATE TABLE IF NOT EXISTS feed_schema_compatibility (
  id integer PRIMARY KEY CHECK(id=1),
  min_reader_contract integer NOT NULL CHECK(min_reader_contract>0),
  max_reader_contract integer NOT NULL CHECK(max_reader_contract>=min_reader_contract),
  min_writer_contract integer NOT NULL CHECK(min_writer_contract>0),
  max_writer_contract integer NOT NULL CHECK(max_writer_contract>=min_writer_contract)
);
INSERT INTO feed_schema_compatibility VALUES(1,1,1,1,1) ON CONFLICT(id) DO NOTHING;
UPDATE feed_runtime_control SET schema_version=7 WHERE id=1 AND schema_version=6;
