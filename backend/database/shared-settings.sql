-- Engineer admin connection, in the target database after role/bootstrap grants.
-- Prevent unattended shared migration statements/locks from waiting forever.
ALTER ROLE it_migration IN DATABASE :"database" SET statement_timeout = '60s';
ALTER ROLE it_migration IN DATABASE :"database" SET lock_timeout = '10s';
