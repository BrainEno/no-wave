-- Runs once, when the PostgreSQL data volume is first created.
--
-- The development database (no_wave_dev) is created by POSTGRES_DB in
-- compose.yaml. The integration tests need a separate database so that
-- `pnpm test` never truncates the data a developer is looking at in the Web app.
CREATE DATABASE no_wave_test OWNER postgres;
