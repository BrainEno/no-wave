-- Runs once, when the PostgreSQL data volume is first created.
--
-- The development database (bot_thk_dev) is created by POSTGRES_DB in
-- compose.yaml. The integration tests need a separate database so that
-- `pnpm test` never truncates the data a developer is looking at in the Web app.
CREATE DATABASE bot_thk_test OWNER postgres;
