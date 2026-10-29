#!/usr/bin/env bash
# awk/sh programs below are single-quoted on purpose.
# shellcheck disable=SC2016
# Tests for aramo-historic-disposition.sh (M-A8 §1.4) on a FAKE box tree: plan /
# validate / migrate (D1: encrypt + upload to a fake S3 that enforces the bucket
# policy, checksum-verified) / retire (D3: dry-run by default, exact inventory
# sha256 required, restore PASS required for dumps, D2 retained until released,
# changed files refused, files outside the manifest untouched). No AWS, no database.
#
# Run: bash deploy/backup/aramo-historic-disposition.test.sh
# Needs age (or ARAMO_TEST_AGE_IMAGE + docker) and openssl.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d "${ARAMO_TEST_TMP:-${TMPDIR:-/tmp}}/aramo-disposition-test.XXXXXX")"
T="$(cd "$T" && pwd -P)"
trap '[ -n "${KEEP_T:-}" ] || rm -rf -- "$T"' EXIT
# shellcheck source=deploy/backup/testlib.sh disable=SC1091
source "$HERE/testlib.sh"
mkdir -p "$T/tmp"
export TMPDIR="$T/tmp"
tl_setup_age
tl_setup_fake_s3
unset AWS_PROFILE

D=(bash "$HERE/aramo-historic-disposition.sh")
B=aramo-test-backups

echo "== fake box"
box="$T/box"
mkdir -p "$box/opt-aramo-backups" "$box/opt-aramo" "$box/home-ubuntu"
mk() { printf '%s\n' "$2" >"$1"; touch -t "$3" "$1"; }
mk "$box/opt-aramo-backups/pre-aaaa1111-backup-20261001-000000.sql" "-- dump one COPY rows" 202610010000
mk "$box/opt-aramo-backups/pre-bbbb2222-backup-20261020-000000.sql" "-- dump two (newest main)" 202610200000
mk "$box/opt-aramo-backups/pre-aaaa1111-intelligence-backup-20261001-000000.sql" "-- intel one" 202610010000
mk "$box/opt-aramo-backups/pre-bbbb2222-intelligence-backup-20261020-000000.sql" "-- intel two (newest)" 202610200000
mk "$box/opt-aramo-backups/pre-cccc3333-dropped-schemas-x-20261015-000000.dump" "PGDMP fake" 202610150000
mk "$box/opt-aramo-backups/env-pre-aaaa1111-20261001T000000Z" "SECRET_ONE=leak-me-not-1" 202610010000
mk "$box/opt-aramo-backups/rollback-thing-20261002.sql" "UPDATE x SET y = 1;" 202610020000
mk "$box/opt-aramo/.env.bak.20261003-000000" "SECRET_TWO=leak-me-not-2" 202610030000
mk "$box/opt-aramo/aramo-pg-20261004T000000Z.dump" "PGDMP fake two" 202610040000
mk "$box/home-ubuntu/recon-queries.sql" "SELECT 1;" 202610050000
mk "$box/opt-aramo/live.env" "NOT_IN_INVENTORY=1" 202610060000
chmod 644 "$box"/opt-aramo-backups/* "$box/opt-aramo/aramo-pg-20261004T000000Z.dump" "$box/home-ubuntu/recon-queries.sql"
chmod 600 "$box/opt-aramo-backups/env-pre-aaaa1111-20261001T000000Z" "$box/opt-aramo/.env.bak.20261003-000000"

inv="$T/inventory.tsv"
for f in "$box"/opt-aramo-backups/* "$box"/opt-aramo/.env.bak.* "$box"/opt-aramo/*.dump "$box"/home-ubuntu/*; do
  printf '%s\t%s\t%s\t%s\t%s\n' "$f" "$(wc -c <"$f" | tr -d ' ')" "2026-10-01T00:00:00Z" "$(mode_of "$f")" "$(sha_of "$f")"
done >"$inv"
inv_sha="$(sha_of "$inv")"
check "inventory has 10 rows" test "$(wc -l <"$inv" | tr -d ' ')" = 10

echo "== plan / validate"
man="$T/disposition.tsv"
"${D[@]}" plan --inventory "$inv" --out "$man" >/dev/null 2>"$T/plan.err"
check "plan exit 0" test -f "$man"
check "manifest is 0600" test "$(mode_of "$man")" = 600
check "manifest records the inventory sha256" grep -qx "# inventory_sha256=${inv_sha}" "$man"
row() { awk -F'\t' -v p="$box/$1" '$1==p {print $6 " " $7}' "$man"; }
check "dump-main → D1>D3" test "$(row opt-aramo-backups/pre-aaaa1111-backup-20261001-000000.sql)" = "dump-main D1>D3"
check "newest pre-deploy dump-main → D2>D3 (rollback baseline)" test "$(row opt-aramo-backups/pre-bbbb2222-backup-20261020-000000.sql)" = "dump-main D2>D3"
check "newest pre-deploy dump-intelligence → D2>D3" test "$(row opt-aramo-backups/pre-bbbb2222-intelligence-backup-20261020-000000.sql)" = "dump-intelligence D2>D3"
check "older dump-intelligence → D1>D3" test "$(row opt-aramo-backups/pre-aaaa1111-intelligence-backup-20261001-000000.sql)" = "dump-intelligence D1>D3"
check "dropped-schemas dump → D1>D3" test "$(row opt-aramo-backups/pre-cccc3333-dropped-schemas-x-20261015-000000.dump)" = "dump-dropped-schemas D1>D3"
check "env-pre copy → env-copy D1>D3" test "$(row opt-aramo-backups/env-pre-aaaa1111-20261001T000000Z)" = "env-copy D1>D3"
check ".env.bak copy → env-copy D1>D3" test "$(row opt-aramo/.env.bak.20261003-000000)" = "env-copy D1>D3"
check "non-dump .sql scripts → D3" test "$(row opt-aramo-backups/rollback-thing-20261002.sql)$(row home-ubuntu/recon-queries.sql)" = "sql-script D3sql-script D3"
check "D2 rows carry a reason and a review condition" awk -F'\t' '$7=="D2>D3" && $8!="" && $9!="-" {n++} END{exit n!=2}' "$man"
check "validate accepts the planned manifest" "${D[@]}" validate --inventory "$inv" --manifest "$man"
check_not "plan refuses to overwrite a manifest" "${D[@]}" plan --inventory "$inv" --out "$man"
sed 's/\tsql-script\tD3\t/\tsql-script\tD1>D3\t/' "$man" >"$T/bad1.tsv"
check_not "validate rejects a sql-script that is not D3" "${D[@]}" validate --inventory "$inv" --manifest "$T/bad1.tsv"
grep -v 'recon-queries' "$man" >"$T/bad2.tsv"
check_not "validate rejects a manifest missing an inventory file" "${D[@]}" validate --inventory "$inv" --manifest "$T/bad2.tsv"
head -n 3 "$inv" >"$T/inv-other.tsv"
check_not "validate rejects a manifest planned from another inventory" "${D[@]}" validate --inventory "$T/inv-other.tsv" --manifest "$man"
awk -F'\t' 'BEGIN{OFS="\t"} /^\// && /aaaa1111-backup/ {$3=$3+1} {print}' "$man" >"$T/bad3.tsv"
check_not "validate rejects a row whose size differs from the inventory" "${D[@]}" validate --inventory "$inv" --manifest "$T/bad3.tsv"
printf '%s\t1\t2026-10-01T00:00:00Z\t644\t%s\n' "$box/opt-aramo/mystery.bin" "$(printf '0%.0s' $(seq 1 64))" >"$T/inv-unknown.tsv"
check_not "plan refuses an unclassifiable file" "${D[@]}" plan --inventory "$T/inv-unknown.tsv" --out "$T/unknown.tsv"

echo "== migrate (D1)"
age-keygen -o "$T/identity.txt" 2>/dev/null
grep -o 'age1[0-9a-z]*' "$T/identity.txt" | head -1 >"$T/recipients.txt"
export BACKUP_DIR="$T/bk" BACKUP_RECIPIENTS_FILE="$T/recipients.txt" BACKUP_S3_URI="s3://$B" BACKUP_KMS_KEY_ID="$TL_KMS_KEY"
# A source that changed after the inventory stops the whole migration.
cp "$inv" "$T/inv-changed.tsv"
awk -F'\t' 'BEGIN{OFS="\t"} /aaaa1111-backup/ {$5="0000000000000000000000000000000000000000000000000000000000000000"} {print}' "$inv" >"$T/inv-changed.tsv"
"${D[@]}" plan --inventory "$T/inv-changed.tsv" --out "$T/man-changed.tsv" >/dev/null 2>&1
check_not "migrate refuses when a source differs from the inventory" "${D[@]}" migrate --inventory "$T/inv-changed.tsv" --manifest "$T/man-changed.tsv" --record "$T/rec-changed.tsv"
check_not "  … and uploads nothing" grep -q put-object "$FAKE_S3/calls.log"
before_tree="$(cd "$box" && find . -type f -exec sh -c 'for f; do printf "%s %s\n" "$f" "$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -c1-64)"; done' _ {} + | sort)"

rec="$T/d1-record.tsv"
"${D[@]}" migrate --inventory "$inv" --manifest "$man" --record "$rec" >/dev/null 2>"$T/migrate.err"
rc=$?
if [ "$rc" = 0 ]; then ok "migrate exit 0"; else
  bad "migrate exit ${rc}"
  cat "$T/migrate.err"
fi
check "record has 8 rows (all but the 2 D3 scripts)" test "$(grep -vc '^#' "$rec")" = 8
check "every record row is a verified upload" test "$(awk -F'\t' '!/^#/ && $10=="yes"' "$rec" | wc -l | tr -d ' ')" = 8
check "env copies went to historic/env/" test "$(awk -F'\t' '$4=="env-copy" && $6 ~ /^historic\/env\//' "$rec" | wc -l | tr -d ' ')" = 2
check "dumps went to historic/<run_id>/ (not env)" test "$(awk -F'\t' '$4 ~ /^dump-/ && $6 ~ /^historic\/[0-9]+T[0-9]+Z-d1-dump-/' "$rec" | wc -l | tr -d ' ')" = 6
check "record keeps each source sha256" sh -c "awk -F'\t' '!/^#/ {print \$1 \"\t\" \$2}' '$rec' | sort >'$T/a'; awk -F'\t' '\$7 != \"D3\" && !/^#/ {print \$1 \"\t\" \$2}' '$man' | sort >'$T/b'; cmp -s '$T/a' '$T/b'"
puts="$(grep -c '^s3api put-object' "$FAKE_S3/calls.log")"
check "every D1 upload sends SSE-KMS with the bucket key" test "$(grep -c -- "--server-side-encryption aws:kms --ssekms-key-id ${TL_KMS_KEY}" "$FAKE_S3/calls.log")" = "$puts"
check_not "no plaintext secret reached the fake bucket" grep -rq 'leak-me-not' "$FAKE_S3/$B"
envkey="$(awk -F'\t' '$1 ~ /env-pre-aaaa1111/ {print $6}' "$rec")"
check "uploaded env copy decrypts to the source" sh -c "age -d -i '$T/identity.txt' '$FAKE_S3/$B/$envkey' | cmp -s - '$box/opt-aramo-backups/env-pre-aaaa1111-20261001T000000Z'"
after_tree="$(cd "$box" && find . -type f -exec sh -c 'for f; do printf "%s %s\n" "$f" "$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -c1-64)"; done' _ {} + | sort)"
check "migrate modified no source file" test "$before_tree" = "$after_tree"
check_not "migrate refuses to overwrite a record" "${D[@]}" migrate --inventory "$inv" --manifest "$man" --record "$rec"

echo "== retire (D3)"
nfiles() { find "$box" -type f | wc -l | tr -d ' '; }
total="$(nfiles)"
out="$("${D[@]}" retire --inventory "$inv" --manifest "$man" --record "$rec" 2>"$T/dry.err")"
check "dry-run deletes nothing" test "$(nfiles)" = "$total"
check "dry-run: 2 scripts + 2 env copies would be retired" test "$out" = "retire would-retire=4 kept=6 failed=0 mode=DRY-RUN"
check "dry-run: dumps kept without a restore PASS" grep -q 'KEEP.*no PASS restore report for migrated run' "$T/dry.err"
check_not "--execute-d3 without --inventory-sha256 is refused" "${D[@]}" retire --inventory "$inv" --manifest "$man" --record "$rec" --execute-d3
check_not "--execute-d3 with a wrong inventory sha256 is refused" "${D[@]}" retire --inventory "$inv" --manifest "$man" --record "$rec" --execute-d3 --inventory-sha256 "$(printf 'f%.0s' $(seq 1 64))"
check "  … nothing deleted by the refusals" test "$(nfiles)" = "$total"

# Restore PASS reports for the migrated dump runs (as aramo-restore-test.sh writes them).
n=0
for r in $(awk -F'\t' '$4 ~ /^dump-/ {print $5}' "$rec" | sort -u); do
  n=$((n + 1))
  printf 'restore-test run_id=%s class=historic image=x at=2026-10-29T00:00:00Z\nx\noverall=PASS\n' "$r" >"$T/pass-$n.txt"
done
check "the 6 migrated dumps sit in 2 historic runs" test "$n" = 2
printf 'restore-test run_id=r class=historic image=x at=y\noverall=FAIL\n' >"$T/fail.txt"
check_not "a FAIL report is not accepted as --restore-pass" "${D[@]}" retire --inventory "$inv" --manifest "$man" --record "$rec" --restore-pass "$T/fail.txt"
# One D1 file changed after the inventory: it must be refused and kept.
printf 'tamper\n' >>"$box/opt-aramo/.env.bak.20261003-000000"
"${D[@]}" retire --inventory "$inv" --manifest "$man" --record "$rec" --restore-pass "$T/pass-1.txt" --restore-pass "$T/pass-2.txt" \
  --execute-d3 --inventory-sha256 "$inv_sha" --log "$T/retire.log" >"$T/retire.out" 2>/dev/null
rc=$?
check "execute with a changed file exits non-zero" test "$rc" != 0
check "  … retired 7 (2 scripts + 1 env copy + 4 D1 dumps)" grep -qx 'retire retired=7 kept=3 failed=1 mode=EXECUTE' "$T/retire.out"
check "  … the changed file is kept" test -f "$box/opt-aramo/.env.bak.20261003-000000"
check "  … D2 rollback baseline kept" test -f "$box/opt-aramo-backups/pre-bbbb2222-backup-20261020-000000.sql"
check "  … D1 dump retired" test ! -e "$box/opt-aramo-backups/pre-aaaa1111-backup-20261001-000000.sql"
check "  … D3 script retired" test ! -e "$box/home-ubuntu/recon-queries.sql"
check "  … file outside the manifest untouched" test -f "$box/opt-aramo/live.env"
check "  … retire log is 0600 and lists each RETIRED path with its sha256" sh -c "[ \"\$(stat -c %a '$T/retire.log' 2>/dev/null || stat -f %Lp '$T/retire.log')\" = 600 ] && [ \"\$(grep -c '^RETIRED' '$T/retire.log')\" = 7 ]"
check_not "--release-d2 without a routine PASS report keeps D2" sh -c "\"\$@\" retire --inventory '$inv' --manifest '$man' --record '$rec' --restore-pass '$T/pass-1.txt' --restore-pass '$T/pass-2.txt' --release-d2 --routine-restore-pass '$T/pass-1.txt' --execute-d3 --inventory-sha256 '$inv_sha'" _ "${D[@]}"
check "  … D2 still present" test -f "$box/opt-aramo-backups/pre-bbbb2222-backup-20261020-000000.sql"
printf 'restore-test run_id=20261029T033000Z-scheduled class=routine image=x at=y\noverall=PASS\n' >"$T/routine-pass.txt"
"${D[@]}" retire --inventory "$inv" --manifest "$man" --record "$rec" --restore-pass "$T/pass-1.txt" --restore-pass "$T/pass-2.txt" \
  --release-d2 --routine-restore-pass "$T/routine-pass.txt" --execute-d3 --inventory-sha256 "$inv_sha" >"$T/retire2.out" 2>/dev/null
check "release D2 after a routine PASS: both D2 dumps retired" sh -c "[ ! -e '$box/opt-aramo-backups/pre-bbbb2222-backup-20261020-000000.sql' ] && [ ! -e '$box/opt-aramo-backups/pre-bbbb2222-intelligence-backup-20261020-000000.sql' ]"
check "  … the changed file is still refused" test -f "$box/opt-aramo/.env.bak.20261003-000000"
check "  … only the changed file and the non-inventory file remain" test "$(nfiles)" = 2

echo
echo "aramo-historic-disposition.test: ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
