#!/usr/bin/env bash
# ensure-intelligence-db — idempotently create the Talent Intelligence role and
# database on an EXISTING PostgreSQL server (ATI-SEP-1 T0, ADR-0036 Decision 2).
#
# The PROD volume is not fresh, so docker-entrypoint initdb scripts never run
# there; this script is the one path that provisions TI storage, on every deploy
# (deploy/migrate-prod.sh) and on every local `tools/local-stack.sh up`.
#
# It connects with a SUPERUSER URL and, without ever dropping anything:
#   1. creates role INTELLIGENCE_DB_USER (LOGIN, no superuser/createdb/createrole)
#      or, when it exists, re-asserts LOGIN + the password from the environment;
#   2. creates database INTELLIGENCE_DB_NAME owned by that role, or re-asserts
#      its owner;
#   3. revokes CONNECT/TEMPORARY on that database from PUBLIC and grants CONNECT
#      to the TI role only (other roles keep whatever they had elsewhere).
#
# Environment:
#   INTELLIGENCE_ADMIN_DATABASE_URL  superuser URL (any database on the server; ?query stripped)
#   INTELLIGENCE_DB_PASSWORD         REQUIRED — URL-safe characters only [A-Za-z0-9._~-]
#                                    (it is embedded in INTELLIGENCE_DATABASE_URL)
#   INTELLIGENCE_DB_USER             default aramo_intelligence
#   INTELLIGENCE_DB_NAME             default aramo_intelligence
#   PGPASSWORD                       optional — used when the admin URL carries no password
#
# Exit: 0 ensured · 2 configuration refused (nothing touched) · 1 SQL failure.
#
# STRUCTURE: pure validators are testable by `source` (tools/db-sync-intelligence.test.sh);
# main() runs only when executed directly.
set -uo pipefail

# Identifiers are interpolated with format(%I) server-side, but are ALSO restricted
# here so a typo can never create an oddly-quoted role/database.
ti_valid_identifier() {
  printf '%s' "${1:-}" | grep -Eq '^[a-z_][a-z0-9_]{0,62}$'
}

# URL-safe password (RFC 3986 unreserved set), 16+ characters.
ti_valid_password() {
  printf '%s' "${1:-}" | grep -Eq '^[A-Za-z0-9._~-]{16,}$'
}

main() {
  local PSQL_BIN
  PSQL_BIN="$(command -v psql || true)"
  [ -z "$PSQL_BIN" ] && [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
  [ -z "$PSQL_BIN" ] && { echo "ensure-intelligence-db: psql not found" >&2; exit 2; }

  local ADMIN="${INTELLIGENCE_ADMIN_DATABASE_URL:-}"
  [ -n "$ADMIN" ] || { echo "ensure-intelligence-db: INTELLIGENCE_ADMIN_DATABASE_URL not set" >&2; exit 2; }
  ADMIN="$(printf '%s' "$ADMIN" | sed -E 's/\?.*$//')"
  local ROLE="${INTELLIGENCE_DB_USER:-aramo_intelligence}"
  local DB="${INTELLIGENCE_DB_NAME:-aramo_intelligence}"
  local PW="${INTELLIGENCE_DB_PASSWORD:-}"
  export INTELLIGENCE_DB_PASSWORD="$PW"

  ti_valid_identifier "$ROLE" || { echo "ensure-intelligence-db: invalid INTELLIGENCE_DB_USER '$ROLE' (expected [a-z_][a-z0-9_]*)" >&2; exit 2; }
  ti_valid_identifier "$DB" || { echo "ensure-intelligence-db: invalid INTELLIGENCE_DB_NAME '$DB' (expected [a-z_][a-z0-9_]*)" >&2; exit 2; }
  [ -n "$PW" ] || { echo "ensure-intelligence-db: INTELLIGENCE_DB_PASSWORD is not set — refusing to create a TI role without one" >&2; exit 2; }
  ti_valid_password "$PW" || { echo "ensure-intelligence-db: INTELLIGENCE_DB_PASSWORD must be 16+ URL-safe characters [A-Za-z0-9._~-] (it is embedded in INTELLIGENCE_DATABASE_URL)" >&2; exit 2; }

  local issuper
  issuper="$("$PSQL_BIN" "$ADMIN" -X -tAc "SELECT rolsuper FROM pg_roles WHERE rolname = current_user;" 2>&1)" \
    || { echo "ensure-intelligence-db: cannot connect with the admin URL: $issuper" >&2; exit 2; }
  [ "$issuper" = "t" ] || { echo "ensure-intelligence-db: the admin URL's user is not a superuser" >&2; exit 2; }

  # psql variables are interpolated (:'x' / :"x") only in scripts read from stdin
  # or -f, never in -c — hence the heredoc. \gexec runs each generated statement.
  # The password is read with \getenv (psql 15+) so it never appears in argv.
  # CREATE DATABASE cannot run inside a transaction block, so no -1 here.
  local out
  if ! out="$("$PSQL_BIN" "$ADMIN" -X -q -v ON_ERROR_STOP=1 -v role="$ROLE" -v db="$DB" 2>&1 <<'SQL'
\getenv pw INTELLIGENCE_DB_PASSWORD
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'role', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'role', :'pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db', :'role') \gexec
SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'db', :'role') \gexec
SQL
)"; then
    printf '%s\n' "$out" | sed 's/^/    /' >&2
    echo "ensure-intelligence-db: FAILED" >&2
    exit 1
  fi
  echo "ensure-intelligence-db — role ${ROLE} and database ${DB} ensured (owner ${ROLE}; PUBLIC connect revoked)"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
