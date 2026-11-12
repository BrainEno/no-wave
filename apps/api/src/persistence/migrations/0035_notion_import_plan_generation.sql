-- Import previews are valid only against the database that observed their revisions.
-- This local identity is NOT a business fact and must never be transferred/replayed.
CREATE TABLE import_plan_generation (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  generation text NOT NULL CHECK (length(generation) = 32)
);
INSERT INTO import_plan_generation (singleton, generation)
VALUES (1, md5(random()::text || clock_timestamp()::text));
