-- One-time provisioning of the Genie database roles. Run as a SUPERUSER (the
-- provisioning role), once, before the first migration. Reviewable; it changes
-- nothing until someone runs it.
--
--   psql -v db=genie -v owner_pw="$GENIE_OWNER_PASSWORD" -v app_pw="$GENIE_APP_PASSWORD" \
--        -v backup_pw="$GENIE_BACKUP_PASSWORD" -f infra/db/provision-roles.sql
--
-- Passwords arrive as psql variables and are quoted by psql (:'var'), never
-- interpolated by a shell into SQL. Use long random hex passwords
-- (`openssl rand -hex 32`) so they need no URL escaping in connection strings.
--
-- Roles (none may be a superuser; only the backup role bypasses RLS):
--   genie_owner  migration role: owns the database and every table, runs DDL.
--                Not BYPASSRLS; tables use FORCE ROW LEVEL SECURITY, so even
--                the owner is subject to the tenant policies.
--   genie_app    runtime role: SELECT/INSERT/UPDATE/DELETE only, no DDL, not
--                the owner. The API refuses to start in production as a
--                superuser or BYPASSRLS role.
--   genie_backup backup role: read-only (SELECT) with BYPASSRLS so pg_dump
--                can read every tenant's rows. Never give it to the app.
\set ON_ERROR_STOP on

CREATE ROLE genie_owner  LOGIN PASSWORD :'owner_pw'  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE genie_app    LOGIN PASSWORD :'app_pw'    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE genie_backup LOGIN PASSWORD :'backup_pw' NOSUPERUSER BYPASSRLS   NOCREATEDB NOCREATEROLE NOREPLICATION;

ALTER DATABASE :"db" OWNER TO genie_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO genie_owner, genie_app, genie_backup;

\connect :"db"

-- PostgreSQL 15+: schema public is owned by pg_database_owner, so the database
-- owner (genie_owner) can create in it and nobody else can.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO genie_app, genie_backup;

-- Privileges on every table the migration role creates from now on.
ALTER DEFAULT PRIVILEGES FOR ROLE genie_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO genie_app;
ALTER DEFAULT PRIVILEGES FOR ROLE genie_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO genie_app;
ALTER DEFAULT PRIVILEGES FOR ROLE genie_owner IN SCHEMA public GRANT SELECT ON TABLES TO genie_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE genie_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO genie_backup;
