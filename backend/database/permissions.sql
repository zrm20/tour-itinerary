-- Run as administrator in EACH target database owned by it_migration.
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO it_migration, it_runtime;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO it_migration;
GRANT USAGE ON SCHEMA public TO it_runtime;
