-- Additive schema releases may preserve the v1 reader/writer contract. A future
-- incompatible migration must narrow this range before deploying new programs.
CREATE TABLE IF NOT EXISTS feed.schema_compatibility (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  min_reader_contract integer NOT NULL CHECK(min_reader_contract>0),
  max_reader_contract integer NOT NULL CHECK(max_reader_contract>=min_reader_contract),
  min_writer_contract integer NOT NULL CHECK(min_writer_contract>0),
  max_writer_contract integer NOT NULL CHECK(max_writer_contract>=min_writer_contract)
);
INSERT INTO feed.schema_compatibility VALUES(true,1,1,1,1) ON CONFLICT(singleton) DO NOTHING;
