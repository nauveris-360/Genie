#!/usr/bin/env bash
# Restore rehearsal: proves a backup can actually be restored, into a brand-new
# scratch database that is dropped afterwards. It never touches an existing
# database. Reviewable script; it changes no infrastructure.
#
# Connection comes from libpq environment variables for an ADMIN role that can
# create databases and bypass RLS (a superuser, or CREATEDB + BYPASSRLS), on a
# server where the application roles from the backup already exist.
#
#   PGHOST=... PGUSER=postgres infra/scripts/restore-rehearsal.sh /var/backups/genie/genie-<stamp>.dump
#
# Optional: COMPARE_DATABASE=genie  also compares per-table row counts with that
#           database (meaningful only if nothing was written since the backup).
#           KEEP_RESTORE_DB=1         keeps the scratch database for inspection.
set -euo pipefail

dump="${1:?usage: restore-rehearsal.sh <backup.dump>}"
[ -f "$dump" ] || { echo "No such file: $dump" >&2; exit 2; }
dir="$(cd "$(dirname "$dump")" && pwd)"
base="$(basename "$dump")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations_dir="$here/../../apps/api/src/migrations"

echo "1/5 Verifying checksum"
(cd "$dir" && sha256sum --check --quiet "$base.sha256")

scratch="genie_restore_$(date -u +%Y%m%d%H%M%S)_$$"
cleanup() {
  if [ "${KEEP_RESTORE_DB:-0}" = 1 ]; then echo "Kept scratch database: $scratch"; else dropdb --if-exists "$scratch"; fi
}
trap cleanup EXIT

echo "2/5 Restoring into new scratch database $scratch"
createdb "$scratch"
pg_restore --dbname="$scratch" --exit-on-error "$dump"

q() { psql --dbname="$1" -v ON_ERROR_STOP=1 -AtX -c "$2"; }

echo "3/5 Checking applied migrations against this checkout"
restored="$(q "$scratch" "SELECT id FROM schema_migrations ORDER BY id")"
expected="$(cd "$migrations_dir" && ls -1 *.up.sql | sed 's/\.up\.sql$//' | sort)"
if [ "$restored" != "$expected" ]; then
  echo "Migration set differs from this checkout (restored vs expected):" >&2
  diff <(echo "$restored") <(echo "$expected") >&2 || true
  echo "If the backup predates newer migrations, 'npm run migrate' after a real restore applies them." >&2
  exit 1
fi
echo "    $(echo "$restored" | wc -l) migrations match"

echo "4/5 Checking tenant isolation survived the restore"
forced="$(q "$scratch" "SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relrowsecurity AND relforcerowsecurity AND relname IN ('websites','provider_connections','agents','model_policies','tasks','approvals','audit_events')")"
policies="$(q "$scratch" "SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation'")"
[ "$forced" = 7 ] && [ "$policies" = 7 ] || { echo "Row-level security not intact: forced=$forced policies=$policies (expected 7/7)" >&2; exit 1; }
echo "    RLS enabled+forced with tenant_isolation policy on 7/7 tables"

echo "5/5 Row counts"
tables="tenants users memberships invitations sessions websites provider_connections agents model_policies models tasks approvals audit_events"
status=0
for t in $tables; do
  n="$(q "$scratch" "SELECT count(*) FROM $t")"
  line="    $(printf '%-22s' "$t") $n"
  if [ -n "${COMPARE_DATABASE:-}" ]; then
    m="$(q "$COMPARE_DATABASE" "SELECT count(*) FROM $t")"
    if [ "$n" = "$m" ]; then line="$line  (= $COMPARE_DATABASE)"; else line="$line  != $m in $COMPARE_DATABASE"; status=1; fi
  fi
  echo "$line"
done
[ $status = 0 ] || { echo "Row counts differ from $COMPARE_DATABASE" >&2; exit 1; }

echo "Restore rehearsal PASSED for $base"
