-- Run as the database administrator once. Set login passwords separately.
-- Names are deliberately shared with the committed migration's SELECT grant.
CREATE ROLE it_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE it_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
