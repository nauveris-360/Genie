#!/usr/bin/env bash
# Restore rehearsal: proves a backup can actually be restored, into a brand-new
# scratch database on a DISPOSABLE PostgreSQL server, and that the restored copy
# still isolates tenants. Reviewable script; it changes no infrastructure.
#
# Isolation rules, enforced before anything is created:
#   * The target server must be disposable: it may hold no databases other
#     than postgres, template0/1 and earlier genie_restore_* scratch copies.
#     A server that hosts the live Genie database (or anything else) is refused,
#     so a rehearsal can never run beside production or write to it.
#   * Connect as a superuser of that disposable server (libpq env vars:
#     PGHOST, PGPORT, PGUSER, PGPASSWORD or ~/.pgpass).
#   * The scratch database is dropped on exit unless KEEP_RESTORE_DB=1.
# A throwaway server is enough, e.g. a local container that is deleted after:
#   docker run --rm -d --name genie-rehearsal -e POSTGRES_PASSWORD=<random> -p 127.0.0.1:55432:5432 postgres:16.6-bookworm
#   PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=<random> \
#     infra/scripts/restore-rehearsal.sh /var/backups/genie/genie-<stamp>.dump
#
# The Genie roles referenced by the dump (genie_owner, genie_app, genie_backup)
# are created on the disposable server as NOLOGIN roles with production
# attributes when missing; no passwords are involved.
#
# Optional row-count comparison with the SOURCE database, over a separate,
# read-only connection (meaningful only if nothing was written since the
# backup): COMPARE_PGHOST, COMPARE_PGPORT, COMPARE_PGUSER (the backup role),
# COMPARE_PGDATABASE, and COMPARE_PGPASSWORD or ~/.pgpass.
set -euo pipefail

mask='__GENIE_NOT_AVAILABLE__'
for v in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE COMPARE_PGHOST COMPARE_PGPORT COMPARE_PGUSER COMPARE_PGPASSWORD COMPARE_PGDATABASE; do
  [ "${!v:-}" = "$mask" ] && { echo "$v is masked ($mask); set a real value or unset it." >&2; exit 2; }
done
unset PGDATABASE   # every command below names its database explicitly

dump="${1:?usage: restore-rehearsal.sh <backup.dump>}"
[ -f "$dump" ] || { echo "No such file: $dump" >&2; exit 2; }
dir="$(cd "$(dirname "$dump")" && pwd)"
base="$(basename "$dump")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations_dir="$here/../../apps/api/src/migrations"
rls_tables="websites provider_connections agents model_policies tasks approvals audit_events"
all_tables="tenants users memberships invitations sessions websites provider_connections agents model_policies models tasks approvals audit_events"

q() { psql --dbname="$1" -v ON_ERROR_STOP=1 -qAtX -c "$2"; }

echo "1/7 Verifying checksum"
(cd "$dir" && sha256sum --check --quiet "$base.sha256")

echo "2/7 Checking the target server is disposable"
[ "$(q postgres "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")" = t ] \
  || { echo "Connect as a superuser of the disposable server (current role is not)." >&2; exit 1; }
others="$(q postgres "SELECT string_agg(datname, ', ' ORDER BY datname) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1') AND datname NOT LIKE 'genie\_restore\_%'")"
if [ -n "$others" ]; then
  echo "Refusing: this server hosts other databases ($others). Rehearse on a disposable PostgreSQL server, never beside production." >&2
  exit 1
fi
echo "    $(q postgres "SELECT current_setting('server_version')") with no other databases"

scratch="genie_restore_$(date -u +%Y%m%d%H%M%S)_$$"
cleanup() {
  if [ "${KEEP_RESTORE_DB:-0}" = 1 ]; then echo "Kept scratch database: $scratch"; else dropdb --if-exists "$scratch"; fi
}

echo "3/7 Restoring into new scratch database $scratch"
q postgres "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'genie_owner')  THEN CREATE ROLE genie_owner  NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'genie_app')    THEN CREATE ROLE genie_app    NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'genie_backup') THEN CREATE ROLE genie_backup NOLOGIN NOSUPERUSER BYPASSRLS; END IF;
END \$\$" >/dev/null
[ "$(q postgres "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'genie_app'")" = f ] \
  || { echo "genie_app on this server is a superuser or BYPASSRLS; the isolation check would be meaningless." >&2; exit 1; }
createdb "$scratch"
trap cleanup EXIT
pg_restore --dbname="$scratch" --exit-on-error "$dump"

echo "4/7 Checking applied migrations against this checkout"
restored="$(q "$scratch" "SELECT id FROM schema_migrations ORDER BY id")"
expected="$(cd "$migrations_dir" && ls -1 *.up.sql | sed 's/\.up\.sql$//' | sort)"
if [ "$restored" != "$expected" ]; then
  echo "Migration set differs from this checkout (restored vs expected):" >&2
  diff <(echo "$restored") <(echo "$expected") >&2 || true
  echo "If the backup predates newer migrations, the migration job applies them after a real restore." >&2
  exit 1
fi
echo "    $(echo "$restored" | wc -l) migrations match"

echo "5/7 Checking tenant isolation survived the restore"
in_list="'$(echo $rls_tables | sed "s/ /','/g")'"
forced="$(q "$scratch" "SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relrowsecurity AND relforcerowsecurity AND relname IN ($in_list)")"
policies="$(q "$scratch" "SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename IN ($in_list)")"
[ "$forced" = 7 ] && [ "$policies" = 7 ] || { echo "Row-level security not intact: forced=$forced policies=$policies (expected 7/7)" >&2; exit 1; }
echo "    RLS enabled+forced with tenant_isolation policy on 7/7 tables"

echo "6/7 Probing the restored copy as the runtime role (genie_app)"
probe_tenant="$(q "$scratch" "SELECT id FROM tenants ORDER BY created_at, id LIMIT 1")"
for t in $rls_tables; do
  total="$(q "$scratch" "SELECT count(*) FROM $t")"
  none="$(q "$scratch" "SET ROLE genie_app; SELECT count(*) FROM $t")"
  [ "$none" = 0 ] || { echo "genie_app read $none rows of $t without a tenant context (expected 0)" >&2; exit 1; }
  line="    $(printf '%-22s' "$t") no tenant: 0 of $total"
  if [ -n "$probe_tenant" ]; then
    own="$(q "$scratch" "SELECT count(*) FROM $t WHERE tenant_id = '$probe_tenant'")"
    seen="$(q "$scratch" "SET ROLE genie_app; SELECT set_config('app.current_tenant_id', '$probe_tenant', false); SELECT count(*) FROM $t" | tail -n1)"
    [ "$seen" = "$own" ] || { echo "genie_app saw $seen rows of $t for one tenant, expected exactly that tenant's $own" >&2; exit 1; }
    line="$line; one tenant: $seen = its own rows"
  fi
  echo "$line"
done

echo "7/7 Row counts"
status=0
for t in $all_tables; do
  n="$(q "$scratch" "SELECT count(*) FROM $t")"
  line="    $(printf '%-22s' "$t") $n"
  if [ -n "${COMPARE_PGDATABASE:-}" ]; then
    m="$(PGHOST="${COMPARE_PGHOST:-}" PGPORT="${COMPARE_PGPORT:-}" PGUSER="${COMPARE_PGUSER:-}" PGPASSWORD="${COMPARE_PGPASSWORD:-}" \
         PGOPTIONS='-c default_transaction_read_only=on' q "$COMPARE_PGDATABASE" "SELECT count(*) FROM $t")"
    if [ "$n" = "$m" ]; then line="$line  (= source)"; else line="$line  != $m in source"; status=1; fi
  fi
  echo "$line"
done
[ $status = 0 ] || { echo "Row counts differ from the source database" >&2; exit 1; }

echo "Restore rehearsal PASSED for $base"
