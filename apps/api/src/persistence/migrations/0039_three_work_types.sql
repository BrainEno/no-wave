-- 作品类型收拢为三种：小说（novel）/ 诗歌（poetry）/ 其他文体（other）。
-- short_story and serial become novel ("novel" now names all prose fiction);
-- essay, criticism, literary_criticism and nonfiction become other. The CHECK
-- from 0008 is replaced so only the three survivors can be written again.
--
-- The backfill is not a journaled domain transaction: finish or abort any
-- provider capture first, as 0026 requires. It bumps import_revision through
-- the 0034 trigger, which is correct — the work's type did change.
LOCK TABLE articles, provider_migration_sessions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM provider_migration_sessions WHERE status IN ('prepared', 'recording', 'backfilling', 'catching_up')) THEN
    RAISE EXCEPTION 'Finish or abort active provider migration sessions before upgrading work types';
  END IF;
END $$;

UPDATE articles SET work_type = 'novel' WHERE work_type IN ('short_story', 'serial');
UPDATE articles SET work_type = 'other' WHERE work_type IN ('essay', 'criticism', 'literary_criticism', 'nonfiction');

ALTER TABLE articles DROP CONSTRAINT articles_work_type_check;
ALTER TABLE articles ADD CONSTRAINT articles_work_type_check CHECK (work_type IN ('novel', 'poetry', 'other'));
