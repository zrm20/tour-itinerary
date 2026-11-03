\i /setup/roles.sql
-- Disposable local credentials only, never use these in a hosted environment.
ALTER ROLE it_migration PASSWORD 'local-migration';
ALTER ROLE it_runtime PASSWORD 'local-runtime';
CREATE DATABASE it_local OWNER it_migration;
CREATE DATABASE it_shadow OWNER it_migration;
\connect it_local
\set database it_local
\i /setup/permissions.sql
\connect it_shadow
\set database it_shadow
\i /setup/permissions.sql
