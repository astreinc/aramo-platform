#!/usr/bin/env bash
# Sign naming unification — guarded migration-ledger reconciliation.
# Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED §3.1.
#
# libs/esign moved to libs/sign. public._local_migrations keys every applied
# migration by its full relative directory path, so the eleven historical Sign
# migrations are recorded as libs/esign/prisma/migrations/<dir>/ and would look
# PENDING under the new path. Replaying them is unsafe (ten are not idempotent).
# This function re-keys those rows ONLY when the evidence proves they are the same
# migrations, and refuses (exit 3, nothing changed) on any partial state.
#
# Preconditions (all required, else REFUSE):
#   - every legacy row is libs/esign/prisma/migrations/<dir>/ with <dir> listed in
#     tools/sign-naming/ledger-manifest.tsv;
#   - libs/sign/prisma/migrations/<dir>/migration.sql exists and its SHA-256 equals
#     the pinned digest (the file is byte-identical to what ran);
#   - no row exists under libs/sign/prisma/migrations/ yet (no half-done re-key);
#   - the schema those migrations built is present: esign exists and sign does not
#     (the schema-rename migration has not run without its re-key).
# Postconditions (verified inside the same transaction):
#   - zero legacy rows remain; the new-path count equals the legacy count.
# Idempotent: with no legacy rows it is a no-op (fresh database or already done).
#
# Requires: q() (psql -tA wrapper), PSQL_BIN, URL, ROOT — provided by
# tools/db-sync-local.sh, which sources this file. Pure on definition.

SIGN_LEDGER_OLD_PREFIX='libs/esign/prisma/migrations/'
SIGN_LEDGER_NEW_PREFIX='libs/sign/prisma/migrations/'

sign_ledger_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# sign_ledger_status → prints the number of legacy rows awaiting re-key (read-only).
sign_ledger_status() {
  if [ "$(q -c "SELECT to_regclass('public._local_migrations') IS NOT NULL;")" != "t" ]; then echo 0; return 0; fi
  q -c "SELECT count(*) FROM public._local_migrations WHERE name LIKE '${SIGN_LEDGER_OLD_PREFIX}%';"
}

# sign_ledger_reconcile → 0 (re-keyed or nothing to do) | 3 (refused, unchanged).
sign_ledger_reconcile() {
  local manifest="${ROOT}/tools/sign-naming/ledger-manifest.tsv"
  local old new rows row dir expected file actual
  old="$(q -c "SELECT count(*) FROM public._local_migrations WHERE name LIKE '${SIGN_LEDGER_OLD_PREFIX}%';")"
  if [ "$old" = "0" ]; then
    return 0
  fi
  new="$(q -c "SELECT count(*) FROM public._local_migrations WHERE name LIKE '${SIGN_LEDGER_NEW_PREFIX}%';")"
  if [ "$new" != "0" ]; then
    echo "sign-ledger: REFUSED — ${old} legacy and ${new} renamed Sign ledger rows both exist (partial re-key). Nothing changed." >&2
    return 3
  fi
  if [ "$(q -c "SELECT to_regnamespace('esign') IS NOT NULL AND to_regnamespace('sign') IS NULL;")" != "t" ]; then
    echo "sign-ledger: REFUSED — legacy Sign ledger rows exist but the database does not hold schema esign alone (schema state does not match the ledger). Nothing changed." >&2
    return 3
  fi
  rows="$(q -c "SELECT name FROM public._local_migrations WHERE name LIKE '${SIGN_LEDGER_OLD_PREFIX}%' ORDER BY name;")"
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    dir="${row#"$SIGN_LEDGER_OLD_PREFIX"}"
    dir="${dir%/}"
    if [ "${SIGN_LEDGER_OLD_PREFIX}${dir}/" != "$row" ] || [ -z "$dir" ] || [[ "$dir" == */* ]]; then
      echo "sign-ledger: REFUSED — unexpected legacy ledger row '${row}'. Nothing changed." >&2
      return 3
    fi
    expected="$(awk -F'\t' -v d="$dir" '$1 == d { print $2 }' "$manifest")"
    if [ -z "$expected" ]; then
      echo "sign-ledger: REFUSED — legacy row '${dir}' is not in the pinned manifest. Nothing changed." >&2
      return 3
    fi
    file="${ROOT}/${SIGN_LEDGER_NEW_PREFIX}${dir}/migration.sql"
    if [ ! -f "$file" ]; then
      echo "sign-ledger: REFUSED — ${SIGN_LEDGER_NEW_PREFIX}${dir}/migration.sql is missing. Nothing changed." >&2
      return 3
    fi
    actual="$(sign_ledger_sha256 "$file")"
    if [ "$actual" != "$expected" ]; then
      echo "sign-ledger: REFUSED — ${dir} on disk does not match the migration that ran (digest mismatch). Nothing changed." >&2
      return 3
    fi
  done < <(printf '%s\n' "$rows")

  if ! "$PSQL_BIN" "$URL" -v ON_ERROR_STOP=1 --single-transaction -q -t -A >/dev/null <<SQL
UPDATE public._local_migrations
   SET name = '${SIGN_LEDGER_NEW_PREFIX}' || substr(name, length('${SIGN_LEDGER_OLD_PREFIX}') + 1)
 WHERE name LIKE '${SIGN_LEDGER_OLD_PREFIX}%';
DO \$\$
BEGIN
  IF (SELECT count(*) FROM public._local_migrations WHERE name LIKE '${SIGN_LEDGER_OLD_PREFIX}%') <> 0
     OR (SELECT count(*) FROM public._local_migrations WHERE name LIKE '${SIGN_LEDGER_NEW_PREFIX}%') <> ${old} THEN
    RAISE EXCEPTION 'sign-ledger: postcondition failed';
  END IF;
END
\$\$;
SQL
  then
    echo "sign-ledger: REFUSED — the re-key transaction failed and was rolled back. Nothing changed." >&2
    return 3
  fi
  echo "  sign-ledger: re-keyed ${old} historical Sign migration(s) libs/esign → libs/sign (digests verified)"
  return 0
}
