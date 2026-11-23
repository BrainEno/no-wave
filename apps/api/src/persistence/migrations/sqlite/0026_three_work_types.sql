-- 作品类型收拢为三种：小说（novel）/ 诗歌（poetry）/ 其他文体（other）。
-- short_story and serial become novel ("novel" now names all prose fiction);
-- essay, criticism, literary_criticism and nonfiction become other.
--
-- The column CHECK from 0001 cannot be altered in place, and rebuilding
-- `articles` is not safe here: migrations run inside one transaction with
-- foreign keys on, so the DROP of the old table would cascade into every child
-- row. The old CHECK stays (it already admits the three survivors) and the two
-- triggers below refuse the six retired values from now on.
--
-- The backfill is not a journaled domain transaction: finish or abort any
-- provider capture first, as 0017 requires. It bumps import_revision through
-- the 0021 trigger, which is correct — the work's type did change.
CREATE TEMP TABLE three_work_types_capture_guard (active_count INTEGER);
CREATE TEMP TRIGGER three_work_types_capture_guard_check
BEFORE INSERT ON three_work_types_capture_guard WHEN NEW.active_count <> 0
BEGIN SELECT RAISE(ABORT, 'Finish or abort active provider migration sessions before upgrading work types'); END;
INSERT INTO three_work_types_capture_guard
SELECT count(*) FROM provider_migration_sessions
WHERE status IN ('prepared', 'recording', 'backfilling', 'catching_up');
DROP TABLE three_work_types_capture_guard;

UPDATE articles SET work_type = 'novel' WHERE work_type IN ('short_story', 'serial');
UPDATE articles SET work_type = 'other' WHERE work_type IN ('essay', 'criticism', 'literary_criticism', 'nonfiction');

CREATE TRIGGER articles_work_type_insert BEFORE INSERT ON articles
WHEN NEW.work_type NOT IN ('novel', 'poetry', 'other')
BEGIN
  SELECT RAISE(ABORT, 'articles.work_type must be novel, poetry or other.');
END;
CREATE TRIGGER articles_work_type_update BEFORE UPDATE OF work_type ON articles
WHEN NEW.work_type NOT IN ('novel', 'poetry', 'other')
BEGIN
  SELECT RAISE(ABORT, 'articles.work_type must be novel, poetry or other.');
END;
