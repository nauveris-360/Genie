#!/usr/bin/env bash
# Init hook for the official postgres image (mounted at
# /docker-entrypoint-initdb.d). It runs exactly once, when the data volume is
# first initialized, as the image's superuser (POSTGRES_USER), and creates the
# Genie roles from infra/db/provision-roles.sql. The app never connects as
# POSTGRES_USER.
set -euo pipefail
: "${POSTGRES_DB:?}"
: "${GENIE_OWNER_PASSWORD:?set GENIE_OWNER_PASSWORD}"
: "${GENIE_APP_PASSWORD:?set GENIE_APP_PASSWORD}"
: "${GENIE_BACKUP_PASSWORD:?set GENIE_BACKUP_PASSWORD}"

psql --no-psqlrc --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v db="$POSTGRES_DB" \
  -v owner_pw="$GENIE_OWNER_PASSWORD" \
  -v app_pw="$GENIE_APP_PASSWORD" \
  -v backup_pw="$GENIE_BACKUP_PASSWORD" \
  -f "${GENIE_PROVISION_SQL:-/genie-db/provision-roles.sql}"
