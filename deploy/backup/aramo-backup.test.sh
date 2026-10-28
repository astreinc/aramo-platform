#!/usr/bin/env bash
# awk programs below are single-quoted on purpose.
# shellcheck disable=SC2016
# End-to-end check of the M-A8 backup tooling against a LOCAL, seeded
# pgvector/pgvector:pg17 container (no production data, no AWS):
#
#   seed → aramo-backup.sh (pg_dump -Fc | age) → permissions / no-plaintext checks
#        → local OK heartbeat
#        → aramo-restore-test.sh (throwaway --rm --network none container, erasure
#          roles pre-created, counts vs manifest, NO volume left behind)
#        → tamper / wrong-expectation / private-key-on-host / failed-dump negatives
#        → uploads to a FAKE S3 that enforces the M-A8 bucket policy: the SSE-KMS
#          header + key id on EVERY put, manifest last, OK heartbeat with status
#          metadata, FAILED heartbeat on a failed run, checksum mismatch refused,
#          the OnFailure heartbeat script and unit wiring
#        → restore test from s3:// writing PASS/FAIL reports to restore-checks/
#        → aramo-env-snapshot.sh (encrypted .env, keep 3, historic/env/ upload)
#        → aramo-backup-prune.sh (7-day local retention, heartbeats, legal-hold
#          untouched, historic paths refused)
#        → aramo-backup-encrypt-existing.sh (plaintext .sql → .age; source unchanged)
#        → aramo-deletion-replay.sh against a privacy-request ledger fixture (empty
#          replay, plan, stage, verify, live-container refusals)
#
# Run:  bash deploy/backup/aramo-backup.test.sh     (exit 0 = all checks pass)
# Needs docker, openssl and the pgvector/pgvector:pg17 image. If `age`/`age-keygen`
# are not installed, set ARAMO_TEST_AGE_IMAGE to an image that has them (e.g. one
# built FROM pgvector/pgvector:pg17 with `apt-get install age`); the test then
# shims them through `docker run`. The `aws` CLI is never called: a fake one is
# put first on PATH (deploy/backup/testlib.sh).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d "${ARAMO_TEST_TMP:-${TMPDIR:-/tmp}}/aramo-backup-test.XXXXXX")"
T="$(cd "$T" && pwd -P)"
SRC="aramo-backup-test-src-$$"
LS="aramo-backup-test-s3-$$"
IMAGE="${RESTORE_IMAGE:-pgvector/pgvector:pg17}"

RT="aramo-backup-test-replay-$$"
CP="aramo-backup-test-compose-$$"
# shellcheck source=deploy/backup/testlib.sh disable=SC1091
source "$HERE/testlib.sh"

cleanup() {
  docker rm -f -v "$SRC" "$LS" "$RT" "$CP" >/dev/null 2>&1 || true
  rm -rf -- "$T"
}
trap cleanup EXIT

mkdir -p "$T/tmp"
export TMPDIR="$T/tmp"
tl_setup_age
tl_setup_fake_s3
unset AWS_PROFILE

echo "== seed source database (${IMAGE})"
docker run -d --name "$SRC" -e POSTGRES_USER=aramo -e POSTGRES_PASSWORD=test -e POSTGRES_DB=aramo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$SRC" psql -U aramo -d aramo -Atc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec -i "$SRC" psql -X -q -v ON_ERROR_STOP=1 -U aramo -d aramo >/dev/null <<'SQL'
CREATE ROLE aramo_bk_test_definer NOLOGIN;
CREATE ROLE aramo_bk_test_operator NOLOGIN;
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
GRANT USAGE ON SCHEMA consent TO aramo_bk_test_definer;
GRANT SELECT, INSERT ON consent."TalentErasureRun" TO aramo_bk_test_definer;
CREATE FUNCTION consent.s2_probe() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
ALTER FUNCTION consent.s2_probe() OWNER TO aramo_bk_test_definer;
REVOKE ALL ON FUNCTION consent.s2_probe() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consent.s2_probe() TO aramo_bk_test_operator;
CREATE DATABASE aramo_intelligence OWNER aramo_intelligence;
SQL
docker exec -i "$SRC" psql -X -q -v ON_ERROR_STOP=1 -U aramo -d aramo_intelligence >/dev/null <<'SQL'
SET ROLE aramo_intelligence;
CREATE TABLE public._intelligence_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public._intelligence_migrations(name, checksum) VALUES ('t1','x'),('t2','y');
CREATE TABLE public.signal (id int PRIMARY KEY);
SQL
ok "seeded aramo (4 tables, 4 ledger rows) + aramo_intelligence (2 tables, 2 ledger rows)"

echo "== keys (primary + break-glass)"
age-keygen -o "$T/identity.txt" 2>/dev/null
age-keygen -o "$T/identity-breakglass.txt" 2>/dev/null
{
  grep -o 'age1[0-9a-z]*' "$T/identity.txt" | head -1
  grep -o 'age1[0-9a-z]*' "$T/identity-breakglass.txt" | head -1
} >"$T/recipients.txt"
check "recipient file holds two public age1… keys" test "$(grep -Ec '^age1[0-9a-z]{58}$' "$T/recipients.txt")" = 2

export PG_CONTAINER="$SRC" BACKUP_DIR="$T/bk" BACKUP_RECIPIENTS_FILE="$T/recipients.txt" BACKUP_GIT_SHA=0123456789abcdef0123456789abcdef01234567
unset BACKUP_S3_URI BACKUP_KMS_KEY_ID

echo "== backup (local only)"
run_dir="$(bash "$HERE/aramo-backup.sh" --label test-run 2>"$T/backup.log")"
rc=$?
if [ "$rc" = 0 ]; then ok "aramo-backup.sh exit 0"; else
  bad "aramo-backup.sh exit ${rc}"
  cat "$T/backup.log"
fi
m="$run_dir/manifest.tsv"
rid="$(basename "$run_dir")"
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
check "manifest sha256 matches file" test "$(awk -F'\t' '$3=="aramo"{print $6}' "$m")" = "$(sha_of "$run_dir/aramo.dump.age")"
check_not "globals carry no password hashes" sh -c "age -d -i '$T/identity.txt' '$run_dir/globals.sql.age' | grep -Eq 'SCRAM-SHA-256|md5[0-9a-f]{32}'"
check "globals carry the definer/operator roles" sh -c "age -d -i '$T/identity.txt' '$run_dir/globals.sql.age' | grep -q 'CREATE ROLE aramo_bk_test_definer'"
check "break-glass identity decrypts too" sh -c "age -d -i '$T/identity-breakglass.txt' '$run_dir/globals.sql.age' | grep -q 'CREATE ROLE'"
hb="$T/bk/heartbeat/${rid}.json"
check "local heartbeat written (0600)" test "$(mode_of "$hb")" = 600
check "heartbeat status OK with counts (databases=2 artifacts=3)" grep -q '"status":"OK".*"databases":2,"artifacts":3,' "$hb"
check_not "heartbeat carries no data" grep -q 'Seed Person' "$hb"
check_not "no upload attempted without BACKUP_S3_URI" test -s "$FAKE_S3/calls.log"

echo "== backup negatives"
cp "$T/recipients.txt" "$T/bad-recipients.txt"
cat "$T/identity.txt" >>"$T/bad-recipients.txt"
check_not "refuses a recipients file holding a private key" env BACKUP_RECIPIENTS_FILE="$T/bad-recipients.txt" bash "$HERE/aramo-backup.sh" --label neg1
check_not "fails on a missing database" env BACKUP_DATABASES="aramo no_such_db" bash "$HERE/aramo-backup.sh" --label neg2
check_not "refuses a world-readable BACKUP_DIR" env BACKUP_DIR="$T/tmp" bash -c "chmod 755 '$T/tmp'; bash '$HERE/aramo-backup.sh' --label neg3"
chmod 700 "$T/tmp"
check_not "rejects an unsafe label" bash "$HERE/aramo-backup.sh" --label '../x'

echo "== restore test (throwaway, --rm, network=none, no volume left)"
export AGE_IDENTITY_FILE="$T/identity.txt"
vols_before="$(docker volume ls -q | sort)"
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
check "no docker volume left behind (restored data gone)" test "$(docker volume ls -q | sort)" = "$vols_before"
check "restore container was started with --rm" grep -q 'docker run -d --rm --name' "$HERE/aramo-restore-test.sh"
check_not "local run uploads no report" test -s "$FAKE_S3/calls.log"

cp -R "$run_dir" "$T/tampered"
printf 'x' >>"$T/tampered/aramo.dump.age"
check_not "tampered artifact is rejected (sha256/size)" bash "$HERE/aramo-restore-test.sh" "$T/tampered"
check_not "wrong expected table count fails" bash "$HERE/aramo-restore-test.sh" "$run_dir" --expect-tables aramo=99
check "failed restore leaves no volume behind" test "$(docker volume ls -q | sort)" = "$vols_before"
check_not "wrong identity cannot decrypt" env AGE_IDENTITY_FILE="$T/other-identity.txt" sh -c "age-keygen -o '$T/other-identity.txt' 2>/dev/null; bash '$HERE/aramo-restore-test.sh' '$run_dir'"

echo "== uploads (fake S3 enforcing the M-A8 bucket policy)"
B=aramo-test-backups
export BACKUP_S3_URI="s3://$B"
check_not "upload without BACKUP_KMS_KEY_ID is refused" bash "$HERE/aramo-backup.sh" --label nokey
check_not "refusal happens before any dump (no nokey run dir)" sh -c "ls -d '$T'/bk/routine/*-nokey"
check_not "the fake bucket denies a put without SSE-KMS" aws s3api put-object --bucket "$B" --key routine/x --body "$m" --checksum-algorithm SHA256
check_not "the fake bucket denies a put with another KMS key" aws s3api put-object --bucket "$B" --key routine/x --body "$m" --server-side-encryption aws:kms --ssekms-key-id alias/other --checksum-algorithm SHA256
export BACKUP_KMS_KEY_ID="$TL_KMS_KEY"
: >"$FAKE_S3/calls.log"
s3run="$(bash "$HERE/aramo-backup.sh" --label pre-0123abcd 2>"$T/s3.log")"
rc=$?
if [ "$rc" = 0 ]; then ok "pre-deploy backup (--label pre-<sha>) with upload exit 0"; else
  bad "pre-deploy backup with upload exit ${rc}"
  cat "$T/s3.log"
fi
srid="$(basename "$s3run")"
check "run_id carries the pre-<sha> label" test "${srid##*-}" = 0123abcd
check "4 objects uploaded under routine/<run_id>/" test "$(find "$FAKE_S3/$B/routine/$srid" -type f | wc -l | tr -d ' ')" = 4
puts="$(grep -c '^s3api put-object' "$FAKE_S3/calls.log")"
check "5 single-PUT uploads (3 artifacts + manifest + heartbeat)" test "$puts" = 5
check "EVERY upload sends --server-side-encryption aws:kms" test "$(grep -c -- '--server-side-encryption aws:kms' "$FAKE_S3/calls.log")" = "$puts"
check "EVERY upload names the bucket KMS key (--ssekms-key-id)" test "$(grep -c -- "--ssekms-key-id ${TL_KMS_KEY}" "$FAKE_S3/calls.log")" = "$puts"
check "EVERY upload asks for a SHA-256 checksum" test "$(grep -c -- '--checksum-algorithm SHA256' "$FAKE_S3/calls.log")" = "$puts"
check_not "no multipart / s3 cp upload used" grep -q '^s3 cp .* s3://' "$FAKE_S3/calls.log"
check "manifest is the last backup object uploaded" sh -c "grep -- '--key routine/' '$FAKE_S3/calls.log' | tail -1 | grep -q 'manifest.tsv'"
check "heartbeat uploaded after the manifest" sh -c "tail -1 '$FAKE_S3/calls.log' | grep -q -- '--key heartbeat/${srid}.json'"
check "heartbeat object metadata status=OK" grep -q '^status=OK,' "$FAKE_S3/.meta/$B/heartbeat/${srid}.json"
check "uploaded heartbeat says OK" grep -q '"status":"OK"' "$FAKE_S3/$B/heartbeat/${srid}.json"
check "uploaded dump is byte-identical to the local encrypted copy" cmp -s "$s3run/aramo.dump.age" "$FAKE_S3/$B/routine/$srid/aramo.dump.age"

: >"$FAKE_S3/calls.log"
check_not "a failing run (missing database) exits non-zero" env BACKUP_DATABASES="aramo no_such_db" bash "$HERE/aramo-backup.sh" --label hbfail
check "a failing run uploads a FAILED heartbeat" sh -c "ls '$FAKE_S3/$B/heartbeat/' | grep -q -- '-hbfail.json'"
check "FAILED heartbeat metadata" sh -c "cat '$FAKE_S3'/.meta/$B/heartbeat/*-hbfail.json | grep -q '^status=FAILED,'"
check_not "a failing run uploads no routine objects" grep -q -- '--key routine/' "$FAKE_S3/calls.log"
check_not "checksum mismatch from S3 fails the run" env FAKE_S3_CORRUPT=1 bash "$HERE/aramo-backup.sh" --label badsum

echo "== OnFailure heartbeat (systemd)"
hbid="$(bash "$HERE/aramo-backup-heartbeat.sh" --status FAILED --label scheduled --source aramo-pg-backup.service 2>/dev/null)"
check "heartbeat script uploads heartbeat/<ts>-failed-scheduled.json" test -f "$FAKE_S3/$B/heartbeat/${hbid}.json"
check "  … status FAILED, source = the failed unit" grep -q '"status":"FAILED".*"source":"aramo-pg-backup.service"' "$FAKE_S3/$B/heartbeat/${hbid}.json"
check "  … with the KMS header" sh -c "grep -- '--key heartbeat/${hbid}.json' '$FAKE_S3/calls.log' | grep -q -- '--ssekms-key-id ${TL_KMS_KEY}'"
SYSD="$HERE/../systemd"
check "backup service declares OnFailure=aramo-pg-backup-failed.service" grep -qx 'OnFailure=aramo-pg-backup-failed.service' "$SYSD/aramo-pg-backup.service"
check "failure unit runs the FAILED heartbeat" grep -q '^ExecStart=/opt/aramo/deploy/backup/aramo-backup-heartbeat.sh --status FAILED' "$SYSD/aramo-pg-backup-failed.service"
check "backup service prunes after the run" grep -q '^ExecStartPost=/opt/aramo/deploy/backup/aramo-backup-prune.sh$' "$SYSD/aramo-pg-backup.service"

echo "== restore test from s3:// → restore-checks/ report"
: >"$FAKE_S3/calls.log"
check "restore test from s3:// PASS" bash "$HERE/aramo-restore-test.sh" "s3://$B/routine/${srid}"
pass_key="$(cd "$FAKE_S3/$B" && ls restore-checks/*-"${srid}".PASS.txt 2>/dev/null | head -1)"
check "PASS report uploaded to restore-checks/<ts>-<run_id>.PASS.txt" test -n "$pass_key"
check "  … metadata result=PASS" sh -c "grep -q '^result=PASS,run-id=${srid},class=routine' '$FAKE_S3/.meta/$B/$pass_key'"
check "  … report says overall=PASS" grep -qx 'overall=PASS' "$FAKE_S3/$B/$pass_key"
check "  … uploaded with the KMS header" sh -c "grep -- '--key restore-checks/' '$FAKE_S3/calls.log' | grep -q -- '--server-side-encryption aws:kms --ssekms-key-id ${TL_KMS_KEY}'"
check_not "failing restore test (wrong expectation) exits non-zero" bash "$HERE/aramo-restore-test.sh" "s3://$B/routine/${srid}" --expect-tables aramo=99
check "  … and uploads a FAIL report" sh -c "ls '$FAKE_S3/$B'/restore-checks/*-${srid}.FAIL.txt"
check_not "a restore that dies early (tampered) exits non-zero" bash "$HERE/aramo-restore-test.sh" "$T/tampered" --report-s3 "s3://$B"
check "  … and still uploads a FAIL report" sh -c "grep -l '^error=size mismatch: aramo.dump.age' '$FAKE_S3/$B'/restore-checks/*.FAIL.txt"
check "no docker volume left after the s3:// restores" test "$(docker volume ls -q | sort)" = "$vols_before"

echo "== encrypted .env snapshot"
printf 'API_SECRET=do-not-leak-1234\nDATABASE_URL=postgres://x\n' >"$T/live.env"
chmod 600 "$T/live.env"
: >"$FAKE_S3/calls.log"
envout="$(bash "$HERE/aramo-env-snapshot.sh" --label pre-aaaa1111 --env-file "$T/live.env" 2>/dev/null)"
check "env snapshot written as env-<label>.age" test "$(basename "$envout")" = env-pre-aaaa1111.age
check "env snapshot is 0600 in a 0700 dir" sh -c "[ \"\$(stat -c %a '$envout' 2>/dev/null || stat -f %Lp '$envout')\" = 600 ] && [ \"\$(stat -c %a '$T/bk/env' 2>/dev/null || stat -f %Lp '$T/bk/env')\" = 700 ]"
check_not "no plaintext secret in the snapshot" grep -q 'do-not-leak' "$envout"
check "snapshot decrypts to the env file" sh -c "age -d -i '$T/identity.txt' '$envout' | cmp -s - '$T/live.env'"
check "uploaded to historic/env/env-<label>.age" test -f "$FAKE_S3/$B/historic/env/env-pre-aaaa1111.age"
check "  … with the KMS header" grep -q -- "--key historic/env/env-pre-aaaa1111.age .*--ssekms-key-id ${TL_KMS_KEY}" "$FAKE_S3/calls.log"
check_not "a used label is refused" bash "$HERE/aramo-env-snapshot.sh" --label pre-aaaa1111 --env-file "$T/live.env"
for l in pre-b pre-c pre-d; do
  bash "$HERE/aramo-env-snapshot.sh" --label "$l" --env-file "$T/live.env" >/dev/null 2>&1
  sleep 1
done
check "at most 3 snapshots kept locally" test "$(ls "$T/bk/env" | wc -l | tr -d ' ')" = 3
check "the oldest local snapshot was the one removed" test ! -e "$T/bk/env/env-pre-aaaa1111.age"
check "every snapshot reached historic/env/" test "$(ls "$FAKE_S3/$B/historic/env" | wc -l | tr -d ' ')" = 4
check_not "no plaintext .env copy anywhere under BACKUP_DIR" grep -rq 'do-not-leak' "$T/bk"
unset BACKUP_S3_URI BACKUP_KMS_KEY_ID

echo "== prune (7-day local retention)"
age_days() { python3 -c 'import os,sys,time; t=time.time()-float(sys.argv[2])*86400; os.utime(sys.argv[1],(t,t))' "$1" "$2"; }
old="$T/bk/routine/20200101T000000Z-old"
mkdir -m 700 "$old"
cp "$m" "$old/manifest.tsv"
touch -t 202001010000 "$old/manifest.tsv"
mid="$T/bk/routine/20261018T000000Z-tenday"
mkdir -m 700 "$mid"
cp "$m" "$mid/manifest.tsv"
age_days "$mid/manifest.tsv" 10
young="$T/bk/routine/20261025T000000Z-threeday"
mkdir -m 700 "$young"
cp "$m" "$young/manifest.tsv"
age_days "$young/manifest.tsv" 3
cp "$hb" "$T/bk/heartbeat/20261018T000000Z-tenday.json"
age_days "$T/bk/heartbeat/20261018T000000Z-tenday.json" 10
mkdir -m 700 "$T/bk/legal-hold"
touch -t 202001010000 "$T/bk/legal-hold"
bash "$HERE/aramo-backup-prune.sh" --dry-run >/dev/null 2>&1
check "dry-run removes nothing" test -d "$old"
bash "$HERE/aramo-backup-prune.sh" >/dev/null 2>&1
check_not "run older than 30 days removed" test -d "$old"
check_not "run 10 days old removed (local window is 7 days)" test -d "$mid"
check "run 3 days old kept" test -d "$young"
check "current run kept" test -f "$m"
check_not "heartbeat 10 days old removed" test -e "$T/bk/heartbeat/20261018T000000Z-tenday.json"
check "current heartbeat kept" test -f "$hb"
check "legal-hold untouched" test -d "$T/bk/legal-hold"
check "env snapshots untouched by prune" test "$(ls "$T/bk/env" | wc -l | tr -d ' ')" = 3
check_not "refuses historic location /opt/aramo-backups" env BACKUP_DIR=/opt/aramo-backups bash "$HERE/aramo-backup-prune.sh" --dry-run

echo "== encrypt existing plaintext dump (historic path)"
mkdir -m 700 "$T/historic-src"
docker exec "$SRC" pg_dump -U aramo -d aramo >"$T/historic-src/pre-test-backup-20260101-000000.sql"
before="$(sha_of "$T/historic-src/pre-test-backup-20260101-000000.sql")"
hdir="$(bash "$HERE/aramo-backup-encrypt-existing.sh" --label test-hist "$T/historic-src/pre-test-backup-20260101-000000.sql" 2>/dev/null)"
check "historic run created" test -f "$hdir/manifest.tsv"
check "source file unchanged (sha256)" test "$(sha_of "$T/historic-src/pre-test-backup-20260101-000000.sql")" = "$before"
check "manifest records source sha256" awk -F'\t' -v s="$before" '$1=="artifact" && $10==s {f=1} END{exit !f}' "$hdir/manifest.tsv"
check "historic plain-sql restores with explicit expectations" bash "$HERE/aramo-restore-test.sh" "$hdir" --expect-tables aramo=4 --expect-ledger aramo=4
check_not "--class legal-hold is refused (hold is placed on the uploaded version)" bash "$HERE/aramo-backup-encrypt-existing.sh" --class legal-hold --label hold-x "$T/historic-src/pre-test-backup-20260101-000000.sql"

echo "== deletion replay (privacy-request ledger fixture)"
MIG="$HERE/../../libs/identity/prisma/migrations/20261030030000_privacy_requests/migration.sql"
T_BACKUP="2026-10-28T03:30:00Z"
# The ledger: a separate database in the seeded container (stands in for the live one).
docker exec "$SRC" psql -X -q -U aramo -d aramo -c 'CREATE DATABASE aramo_ledger' >/dev/null
{
  echo 'CREATE SCHEMA identity;'
  cat "$MIG"
  cat <<'SQL'
INSERT INTO identity."PrivacyRequest" (id, reference, request_type, subject_kind, channel, status, due_at, created_at, completed_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','PR-AAAA-AAAA-AAA1','DELETION','ACCOUNT_HOLDER','OPERATOR','COMPLETED','2026-11-30T00:00:00Z','2026-10-29T00:00:00Z','2026-10-29T02:00:00Z'),
 ('00000000-0000-0000-0000-0000000000a2','PR-AAAA-AAAA-AAA2','DELETION','ACCOUNT_HOLDER','OPERATOR','COMPLETED','2026-11-30T00:00:00Z','2026-10-20T00:00:00Z','2026-10-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000a3','PR-AAAA-AAAA-AAA3','ACCESS','ACCOUNT_HOLDER','OPERATOR','COMPLETED','2026-11-30T00:00:00Z','2026-10-20T00:00:00Z','2026-10-29T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000a4','PR-AAAA-AAAA-AAA4','DELETION','ACCOUNT_HOLDER','OPERATOR','COMPLETED','2026-11-30T00:00:00Z','2026-10-20T00:00:00Z','2026-10-29T05:00:00Z'),
 ('00000000-0000-0000-0000-0000000000a5','PR-AAAA-AAAA-AAA5','DELETION','ACCOUNT_HOLDER','OPERATOR','EXECUTING','2026-11-30T00:00:00Z','2026-10-20T00:00:00Z',NULL);
INSERT INTO identity."PrivacyRequestEvent" (id, request_id, event_type, from_status, to_status, actor_type, created_at) VALUES
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000a1','STATUS_CHANGED','EXECUTING','COMPLETED','SYSTEM','2026-10-29T02:00:00Z'),
 ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000a2','STATUS_CHANGED','EXECUTING','COMPLETED','SYSTEM','2026-10-27T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-0000000000a3','STATUS_CHANGED','EXECUTING','COMPLETED','SYSTEM','2026-10-29T00:00:00Z'),
 ('00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-0000000000a4','EXECUTED','EXECUTING','EXECUTING','SYSTEM','2026-10-29T05:00:00Z'),
 ('00000000-0000-0000-0000-0000000000e5','00000000-0000-0000-0000-0000000000a5','EXECUTION_FAILED','EXECUTING','EXECUTING','SYSTEM','2026-10-29T06:00:00Z');
SQL
} | docker exec -i "$SRC" psql -X -q -v ON_ERROR_STOP=1 -U aramo -d aramo_ledger >/dev/null
# The RESTORED database: standalone, network-isolated, holding the pre-backup state.
docker run -d --rm --name "$RT" --network none -e POSTGRES_USER=aramo -e POSTGRES_PASSWORD=test -e POSTGRES_DB=aramo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$RT" psql -U aramo -d aramo -Atc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
{
  echo 'CREATE SCHEMA identity;'
  cat "$MIG"
  cat <<'SQL'
INSERT INTO identity."PrivacyRequest" (id, reference, request_type, subject_kind, channel, status, due_at, created_at) VALUES
 ('00000000-0000-0000-0000-0000000000a4','PR-AAAA-AAAA-AAA4','DELETION','ACCOUNT_HOLDER','OPERATOR','DATA_INVENTORY','2026-11-30T00:00:00Z','2026-10-20T00:00:00Z');
SQL
} | docker exec -i "$RT" psql -X -q -v ON_ERROR_STOP=1 -U aramo -d aramo >/dev/null
REPLAY=(bash "$HERE/aramo-deletion-replay.sh" --backup-created-at "$T_BACKUP")

out="$("${REPLAY[@]}" --source-container "$SRC" --source-db aramo --db-container "$RT" 2>/dev/null)"
rc=$?
check "ledger tables absent (execution never activated) → empty replay, exit 0" test "$rc" = 0
check "  … reported as EMPTY" sh -c "printf '%s' '$out' | grep -q 'executed_deletions=0 verdict=EMPTY'"
out="$(bash "$HERE/aramo-deletion-replay.sh" --backup-created-at 2026-12-01T00:00:00Z --source-container "$SRC" --source-db aramo_ledger --db-container "$RT" 2>/dev/null)"
rc=$?
check "no executed deletion after the backup → empty replay, exit 0" test "$rc" = 0
"${REPLAY[@]}" --source-container "$SRC" --source-db aramo_ledger --db-container "$RT" --plan "$T/replay-plan.tsv" >"$T/replay.out" 2>/dev/null
rc=$?
check "executed deletions after the backup → replay REQUIRED, exit 4" test "$rc" = 4
check "  … plan selects exactly the 2 executed DELETIONs after created_at" test "$(cut -f1 "$T/replay-plan.tsv" | tr '\n' ' ')" = "00000000-0000-0000-0000-0000000000a1 00000000-0000-0000-0000-0000000000a4 "
check "  … plan file is 0600" test "$(mode_of "$T/replay-plan.tsv")" = 600
check_not "refuses the live container by name" "${REPLAY[@]}" --source-container "$SRC" --source-db aramo_ledger --db-container aramo-prod-postgres
check_not "refuses the ledger's own container as the target" "${REPLAY[@]}" --source-container "$SRC" --source-db aramo_ledger --db-container "$SRC" --db-name aramo_ledger
docker create --name "$CP" --label com.docker.compose.service=postgres "$IMAGE" >/dev/null
check_not "refuses a docker compose service container" "${REPLAY[@]}" --source-container "$SRC" --source-db aramo_ledger --db-container "$CP" --stage
"${REPLAY[@]}" --source-container "$SRC" --source-db aramo_ledger --db-container "$RT" --stage >"$T/stage.out" 2>/dev/null
rc=$?
check "--stage exits 4 (replay pending)" test "$rc" = 4
check "  … staged=2 inserted=1" grep -q 'staged=2 inserted=1 already_completed=0' "$T/stage.out"
rq() { docker exec "$RT" psql -X -At -U aramo -d aramo -c "$1"; }
check "  … both requests EXECUTING in the restored database" test "$(rq "SELECT count(*) FROM identity.\"PrivacyRequest\" WHERE status='EXECUTING'")" = 2
check "  … one REPLAY_STAGED event each" test "$(rq "SELECT count(*) FROM identity.\"PrivacyRequestEvent\" WHERE event_type='REPLAY_STAGED'")" = 2
check "  … the ledger was only read (unchanged)" test "$(docker exec "$SRC" psql -X -At -U aramo -d aramo_ledger -c 'SELECT count(*) FROM identity."PrivacyRequestEvent"')" = 5
"${REPLAY[@]}" --source-container "$SRC" --source-db aramo_ledger --db-container "$RT" --verify >/dev/null 2>&1
rc=$?
check "--verify before the execution worker ran → exit 4" test "$rc" = 4
# Stand-in for the sign-service execution worker completing the staged requests.
rq "UPDATE identity.\"PrivacyRequest\" SET status='COMPLETED', completed_at=now() WHERE status='EXECUTING'" >/dev/null
"${REPLAY[@]}" --source-container "$SRC" --source-db aramo_ledger --db-container "$RT" --verify >"$T/verify.out" 2>/dev/null
rc=$?
check "--verify after execution → exit 0 (COMPLETE)" test "$rc" = 0
check "  … verdict=COMPLETE" grep -q 'completed_in_restore=2 verdict=COMPLETE' "$T/verify.out"

echo
echo "aramo-backup.test: ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
