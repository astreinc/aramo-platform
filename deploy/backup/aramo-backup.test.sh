#!/usr/bin/env bash
# awk programs below are single-quoted on purpose.
# shellcheck disable=SC2016
# End-to-end check of the R-15 backup tooling against a LOCAL, seeded
# pgvector/pgvector:pg17 container (no production data involved):
#
#   seed → aramo-backup.sh (pg_dump -Fc | age) → permissions / no-plaintext checks
#        → aramo-restore-test.sh (throwaway --network none container, erasure
#          roles pre-created, table + ledger counts vs manifest)
#        → tamper / wrong-expectation / private-key-on-host / failed-dump negatives
#        → aramo-backup-prune.sh (30-day local retention, legal-hold untouched,
#          historic paths refused)
#        → aramo-backup-encrypt-existing.sh (plaintext .sql → .age; source unchanged)
#        → aramo-deletion-replay.sh fails closed
#        → optional S3 round trip against localstack (ARAMO_TEST_S3=1)
#
# Run:  bash deploy/backup/aramo-backup.test.sh     (exit 0 = all checks pass)
# Needs docker and the pgvector/pgvector:pg17 image. If `age`/`age-keygen` are
# not installed, set ARAMO_TEST_AGE_IMAGE to an image that has them (e.g. one
# built FROM pgvector/pgvector:pg17 with `apt-get install age`); the test then
# shims them through `docker run`. ARAMO_TEST_S3=1 also needs the `aws` CLI and
# the localstack/localstack:3 image.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d "${ARAMO_TEST_TMP:-${TMPDIR:-/tmp}}/aramo-backup-test.XXXXXX")"
T="$(cd "$T" && pwd -P)"
SRC="aramo-backup-test-src-$$"
LS="aramo-backup-test-s3-$$"
IMAGE="${RESTORE_IMAGE:-pgvector/pgvector:pg17}"

pass=0
fail=0
ok() { echo "  ok    $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $*"; fail=$((fail + 1)); }
check() { # check <desc> <cmd…>
  local d="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
check_not() {
  local d="$1"
  shift
  if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi
}

cleanup() {
  docker rm -f "$SRC" "$LS" >/dev/null 2>&1 || true
  rm -rf -- "$T"
}
trap cleanup EXIT

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# --- age (real or shimmed) ----------------------------------------------------
mkdir -p "$T/bin" "$T/tmp"
export TMPDIR="$T/tmp"
if ! command -v age >/dev/null 2>&1; then
  [ -n "${ARAMO_TEST_AGE_IMAGE:-}" ] || {
    echo "age not installed and ARAMO_TEST_AGE_IMAGE unset" >&2
    exit 2
  }
  for b in age age-keygen; do
    cat >"$T/bin/$b" <<EOF
#!/usr/bin/env bash
exec docker run --rm -i -u "\$(id -u):\$(id -g)" -v "$T:$T" -w "\$PWD" "$ARAMO_TEST_AGE_IMAGE" $b "\$@"
EOF
    chmod +x "$T/bin/$b"
  done
  export PATH="$T/bin:$PATH"
  echo "  (age shimmed via ${ARAMO_TEST_AGE_IMAGE})"
fi

echo "== seed source database (${IMAGE})"
docker run -d --name "$SRC" -e POSTGRES_USER=aramo -e POSTGRES_PASSWORD=test -e POSTGRES_DB=aramo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$SRC" psql -U aramo -d aramo -Atc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec -i "$SRC" psql -X -q -v ON_ERROR_STOP=1 -U aramo -d aramo >/dev/null <<'SQL'
CREATE ROLE aramo_erasure_definer NOLOGIN;
CREATE ROLE aramo_erasure_operator NOLOGIN;
CREATE ROLE aramo_intelligence LOGIN PASSWORD 'test-only';
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE public._local_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public._local_migrations(name, checksum) VALUES ('m1','a'),('m2','b'),('m3','c'),('m4','d');
CREATE SCHEMA consent;
CREATE TABLE consent."TalentErasureRun" (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE SCHEMA talent_record;
CREATE TABLE talent_record."TalentRecord" (id uuid PRIMARY KEY, display_name text, embedding vector(3));
INSERT INTO talent_record."TalentRecord" VALUES ('00000000-0000-0000-0000-000000000001','Seed Person One','[1,2,3]');
CREATE SCHEMA sign;
CREATE TABLE sign."Envelope" (id uuid PRIMARY KEY, title text);
GRANT USAGE ON SCHEMA consent TO aramo_erasure_definer;
GRANT SELECT, INSERT ON consent."TalentErasureRun" TO aramo_erasure_definer;
CREATE FUNCTION consent.s2_probe() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
ALTER FUNCTION consent.s2_probe() OWNER TO aramo_erasure_definer;
REVOKE ALL ON FUNCTION consent.s2_probe() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consent.s2_probe() TO aramo_erasure_operator;
CREATE DATABASE aramo_intelligence OWNER aramo_intelligence;
SQL
docker exec -i "$SRC" psql -X -q -v ON_ERROR_STOP=1 -U aramo -d aramo_intelligence >/dev/null <<'SQL'
SET ROLE aramo_intelligence;
CREATE TABLE public._intelligence_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public._intelligence_migrations(name, checksum) VALUES ('t1','x'),('t2','y');
CREATE TABLE public.signal (id int PRIMARY KEY);
SQL
ok "seeded aramo (4 tables, 4 ledger rows) + aramo_intelligence (2 tables, 2 ledger rows)"

echo "== keys"
age-keygen -o "$T/identity.txt" 2>/dev/null
grep -o 'age1[0-9a-z]*' "$T/identity.txt" | head -1 >"$T/recipients.txt"
check "recipient file holds one public age1… key" grep -Eq '^age1[0-9a-z]{58}$' "$T/recipients.txt"

export PG_CONTAINER="$SRC" BACKUP_DIR="$T/bk" BACKUP_RECIPIENTS_FILE="$T/recipients.txt" BACKUP_GIT_SHA=0123456789abcdef0123456789abcdef01234567
unset BACKUP_S3_URI

echo "== backup"
run_dir="$(bash "$HERE/aramo-backup.sh" --label test-run 2>"$T/backup.log")"
rc=$?
if [ "$rc" = 0 ]; then ok "aramo-backup.sh exit 0"; else
  bad "aramo-backup.sh exit ${rc}"
  cat "$T/backup.log"
fi
m="$run_dir/manifest.tsv"
check "manifest written" test -f "$m"
check "BACKUP_DIR is 0700" test "$(mode_of "$T/bk")" = 700
check "run dir is 0700" test "$(mode_of "$run_dir")" = 700
for f in "$run_dir"/*; do
  check "$(basename "$f") is 0600" test "$(mode_of "$f")" = 600
done
check "3 encrypted artifacts (aramo, aramo_intelligence, globals)" test "$(find "$run_dir" -name '*.age' | wc -l | tr -d ' ')" = 3
check_not "no plaintext pg_dump magic in aramo.dump.age" grep -q PGDMP "$run_dir/aramo.dump.age"
check_not "no plaintext row content in aramo.dump.age" grep -q 'Seed Person One' "$run_dir/aramo.dump.age"
check "age header present" grep -q 'age-encryption.org/v1' "$run_dir/aramo.dump.age"
check_not "no partial files left" ls "$run_dir"/*.partial
check "manifest records git SHA" grep -q "^git_sha=${BACKUP_GIT_SHA}\$" "$m"
check "manifest: aramo tables=4 ledger=4" awk -F'\t' '$1=="artifact" && $3=="aramo" && $7==4 && $8=="public._local_migrations" && $9==4 {f=1} END{exit !f}' "$m"
check "manifest: aramo_intelligence tables=2 ledger=2" awk -F'\t' '$1=="artifact" && $3=="aramo_intelligence" && $7==2 && $8=="public._intelligence_migrations" && $9==2 {f=1} END{exit !f}' "$m"
check "manifest sha256 matches file" test "$(awk -F'\t' '$3=="aramo"{print $6}' "$m")" = "$( (sha256sum "$run_dir/aramo.dump.age" 2>/dev/null || shasum -a 256 "$run_dir/aramo.dump.age") | awk '{print $1}')"
check_not "globals carry no password hashes" sh -c "age -d -i '$T/identity.txt' '$run_dir/globals.sql.age' | grep -Eq 'SCRAM-SHA-256|md5[0-9a-f]{32}'"
check "globals carry the erasure roles" sh -c "age -d -i '$T/identity.txt' '$run_dir/globals.sql.age' | grep -q 'CREATE ROLE aramo_erasure_definer'"

echo "== backup negatives"
cp "$T/recipients.txt" "$T/bad-recipients.txt"
cat "$T/identity.txt" >>"$T/bad-recipients.txt"
check_not "refuses a recipients file holding a private key" env BACKUP_RECIPIENTS_FILE="$T/bad-recipients.txt" bash "$HERE/aramo-backup.sh" --label neg1
check_not "fails on a missing database" env BACKUP_DATABASES="aramo no_such_db" bash "$HERE/aramo-backup.sh" --label neg2
check_not "refuses a world-readable BACKUP_DIR" env BACKUP_DIR="$T/tmp" bash -c "chmod 755 '$T/tmp'; bash '$HERE/aramo-backup.sh' --label neg3"
chmod 700 "$T/tmp"
check_not "rejects an unsafe label" bash "$HERE/aramo-backup.sh" --label '../x'

echo "== restore test (throwaway, network=none)"
export AGE_IDENTITY_FILE="$T/identity.txt"
if bash "$HERE/aramo-restore-test.sh" "$run_dir" --report "$T/report.txt" >"$T/rt.out" 2>"$T/rt.err"; then
  ok "aramo-restore-test.sh PASS"
else
  bad "aramo-restore-test.sh failed"
  cat "$T/rt.out" "$T/rt.err"
fi
check "report overall=PASS" grep -q '^overall=PASS$' "$T/report.txt"
check "report: aramo restored, 4 tables / 4 ledger rows, PASS" grep -Eq '^aramo +pg_dump-custom\+age +4 +4 +public._local_migrations +4 +4 PASS$' "$T/report.txt"
check "report: aramo_intelligence restored, 2 tables / 2 ledger rows, PASS" grep -Eq '^aramo_intelligence +pg_dump-custom\+age +2 +2 +public._intelligence_migrations +2 +2 PASS$' "$T/report.txt"
sed 's/^/        /' "$T/report.txt"
check_not "no restore container left behind" sh -c "docker ps -a --format '{{.Names}}' | grep -q '^aramo-restore-test-'"

cp -R "$run_dir" "$T/tampered"
printf 'x' >>"$T/tampered/aramo.dump.age"
check_not "tampered artifact is rejected (sha256/size)" bash "$HERE/aramo-restore-test.sh" "$T/tampered"
check_not "wrong expected table count fails" bash "$HERE/aramo-restore-test.sh" "$run_dir" --expect-tables aramo=99
check_not "wrong identity cannot decrypt" env AGE_IDENTITY_FILE="$T/other-identity.txt" sh -c "age-keygen -o '$T/other-identity.txt' 2>/dev/null; bash '$HERE/aramo-restore-test.sh' '$run_dir'"

echo "== prune"
old="$T/bk/routine/20200101T000000Z-old"
mkdir -m 700 "$old"
cp "$m" "$old/manifest.tsv"
touch -t 202001010000 "$old/manifest.tsv"
mkdir -m 700 "$T/bk/legal-hold"
touch -t 202001010000 "$T/bk/legal-hold"
bash "$HERE/aramo-backup-prune.sh" --dry-run >/dev/null 2>&1
check "dry-run removes nothing" test -d "$old"
bash "$HERE/aramo-backup-prune.sh" >/dev/null 2>&1
check_not "run older than 30 days removed" test -d "$old"
check "current run kept" test -f "$m"
check "legal-hold untouched" test -d "$T/bk/legal-hold"
check_not "refuses historic location /opt/aramo-backups" env BACKUP_DIR=/opt/aramo-backups bash "$HERE/aramo-backup-prune.sh" --dry-run

echo "== encrypt existing plaintext dump (historic path)"
mkdir -m 700 "$T/historic-src"
docker exec "$SRC" pg_dump -U aramo -d aramo >"$T/historic-src/pre-test-backup-20260101-000000.sql"
before="$( (sha256sum "$T/historic-src/pre-test-backup-20260101-000000.sql" 2>/dev/null || shasum -a 256 "$T/historic-src/pre-test-backup-20260101-000000.sql") | awk '{print $1}')"
hdir="$(bash "$HERE/aramo-backup-encrypt-existing.sh" --class historic --label test-hist "$T/historic-src/pre-test-backup-20260101-000000.sql" 2>/dev/null)"
check "historic run created" test -f "$hdir/manifest.tsv"
check "source file unchanged (sha256)" test "$( (sha256sum "$T/historic-src/pre-test-backup-20260101-000000.sql" 2>/dev/null || shasum -a 256 "$T/historic-src/pre-test-backup-20260101-000000.sql") | awk '{print $1}')" = "$before"
check "manifest records source sha256" awk -F'\t' -v s="$before" '$1=="artifact" && $10==s {f=1} END{exit !f}' "$hdir/manifest.tsv"
check "historic plain-sql restores with explicit expectations" bash "$HERE/aramo-restore-test.sh" "$hdir" --expect-tables aramo=4 --expect-ledger aramo=4

echo "== deletion replay hook"
bash "$HERE/aramo-deletion-replay.sh" --db-container restored-x --backup-created-at 2026-10-28T00:00:00Z >/dev/null 2>&1
rc=$?
check "deletion replay fails closed (exit 3)" test "$rc" = 3
check_not "deletion replay refuses the live container" bash "$HERE/aramo-deletion-replay.sh" --db-container aramo-prod-postgres --backup-created-at 2026-10-28T00:00:00Z

if [ "${ARAMO_TEST_S3:-0}" = "1" ]; then
  echo "== S3 round trip (localstack)"
  docker run -d --name "$LS" -p 127.0.0.1:4566:4566 -e SERVICES=s3 localstack/localstack:3 >/dev/null
  for _ in $(seq 1 60); do
    curl -fs http://127.0.0.1:4566/_localstack/health 2>/dev/null | grep -q '"s3": "\(available\|running\)"' && break
    sleep 1
  done
  export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 AWS_ENDPOINT_URL=http://127.0.0.1:4566
  aws s3 mb s3://aramo-test-backups >/dev/null 2>&1
  s3run="$(BACKUP_S3_URI=s3://aramo-test-backups bash "$HERE/aramo-backup.sh" --label s3-run 2>/dev/null)"
  rid="$(basename "$s3run")"
  check "4 objects uploaded under routine/<run_id>/" test "$(aws s3 ls "s3://aramo-test-backups/routine/${rid}/" | wc -l | tr -d ' ')" = 4
  check "restore test from s3:// PASS" bash "$HERE/aramo-restore-test.sh" "s3://aramo-test-backups/routine/${rid}"
fi

echo
echo "aramo-backup.test: ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
