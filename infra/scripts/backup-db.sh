#!/usr/bin/env bash
# Database-aware backup of the Genie PostgreSQL database (custom-format dump +
# SHA-256 checksum). Reviewable script; it uploads nothing and changes no
# infrastructure. Copy BOTH output files off-server yourself (see RUNBOOK).
#
# Connection comes from standard libpq environment variables (PGHOST, PGPORT,
# PGUSER, PGDATABASE, and PGPASSWORD or ~/.pgpass), never from a URL on the
# command line, so the password does not appear in `ps` output.
#
# PGUSER must be a backup role with BYPASSRLS (see docs/RUNBOOK.md "Backups").
# Tenant tables use FORCE ROW LEVEL SECURITY, so the application role cannot
# dump them: pg_dump fails loudly instead of writing a partial backup. Never
# "fix" that with --enable-row-security, which would silently dump zero rows.
#
#   PGHOST=... PGUSER=genie_backup PGDATABASE=genie BACKUP_DIR=/var/backups/genie \
#     infra/scripts/backup-db.sh
#
# Then rehearse the restore on a DISPOSABLE server with restore-rehearsal.sh
# (it refuses a server that hosts any other database).
set -euo pipefail
umask 077

# A masked deployment value (Coolify stack .env) is never a usable setting.
for v in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE BACKUP_DIR; do
  [ "${!v:-}" = '__GENIE_NOT_AVAILABLE__' ] && { echo "$v is masked (__GENIE_NOT_AVAILABLE__); set a real value or unset it." >&2; exit 2; }
done

: "${PGDATABASE:?set PGDATABASE (and PGHOST/PGUSER/PGPASSWORD or ~/.pgpass)}"
: "${BACKUP_DIR:?set BACKUP_DIR to a local directory}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="genie-${stamp}.dump"
partial="$BACKUP_DIR/.${name}.partial"
trap 'rm -f "$partial"' EXIT

pg_dump --format=custom --compress=6 --file="$partial"
pg_restore --list "$partial" >/dev/null   # archive is readable end to end
mv "$partial" "$BACKUP_DIR/$name"
(cd "$BACKUP_DIR" && sha256sum "$name" > "$name.sha256")

echo "Backup written: $BACKUP_DIR/$name ($(du -h "$BACKUP_DIR/$name" | cut -f1))"
echo "Checksum:       $BACKUP_DIR/$name.sha256"
echo "Next: copy both files off-server, then rehearse a restore with infra/scripts/restore-rehearsal.sh."
