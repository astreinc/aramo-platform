# shellcheck shell=bash
# Aramo backup tooling — shared helpers (M-A8 §1; was M-A7 §2 / R-15). Sourced, never run.
#
# Sourced by every deploy/backup/*.sh script.
# Portable across the box (Ubuntu 24.04, GNU coreutils, bash 5) and the
# operator Mac (BSD stat/shasum, bash 3.2) because restore tests run on the Mac:
# the age IDENTITY (private key) never exists on the box.

# Manifest format version. Bump on any column change in bk_manifest_artifact.
BK_MANIFEST_VERSION=1

bk_log() { printf '%s: %s\n' "${BK_TAG:-aramo-backup}" "$*" >&2; }

BK_LAST_ERROR=""
bk_die() {
  BK_LAST_ERROR="$1"
  bk_log "FATAL: $1"
  exit "${2:-1}"
}

bk_need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || bk_die "required command not found: ${c}"
  done
}

bk_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

bk_size() { wc -c <"$1" | tr -d ' '; }

bk_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

bk_uid() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"; }

bk_mtime_iso() {
  local s
  s="$(stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1")"
  date -u -d "@${s}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$s" +%Y-%m-%dT%H:%M:%SZ
}

bk_now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
bk_now_compact() { date -u +%Y%m%dT%H%M%SZ; }

# A label becomes part of a directory name and an S3 key: allow-list it.
bk_check_label() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] ||
    bk_die "label must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ (got '${1}')" 2
}

# bk_private_dir <dir>: create (0700, current user) or verify an existing dir.
# Fails closed instead of chmod-ing a directory it did not create, so a
# misconfigured BACKUP_DIR (e.g. the 0755 historic /opt/aramo-backups) is
# reported, never silently "fixed".
bk_private_dir() {
  local d="$1" mode uid
  if [ ! -e "$d" ]; then
    (umask 077 && mkdir -p "$d") || bk_die "cannot create ${d}"
    chmod 700 "$d"
  fi
  [ -d "$d" ] || bk_die "${d} exists and is not a directory"
  mode="$(bk_mode "$d")"
  uid="$(bk_uid "$d")"
  [ "$mode" = "700" ] || bk_die "${d} has mode ${mode}; backups require a 0700 directory"
  [ "$uid" = "$(id -u)" ] || bk_die "${d} is owned by uid ${uid}, not the running user ($(id -u))"
}

# bk_check_recipients <file>: the box holds PUBLIC recipients only. A file that
# contains an age identity (private key) is refused outright.
bk_check_recipients() {
  local f="$1" n
  [ -s "$f" ] || bk_die "recipients file missing or empty: ${f} (see doc/runbooks/RUNBOOK-backups.md §2 Key custody)"
  if grep -q 'AGE-SECRET-KEY-' "$f"; then
    bk_die "recipients file ${f} contains an age IDENTITY (private key). Remove it from this host; only age1… public recipients belong here."
  fi
  n="$(grep -Ec '^age1[0-9a-z]{58}$' "$f" || true)"
  [ "$n" -ge 1 ] || bk_die "recipients file ${f} has no valid age1… recipient line"
  if grep -Ev '^(#.*|age1[0-9a-z]{58}|[[:space:]]*)$' "$f" | grep -q .; then
    bk_die "recipients file ${f} has lines that are neither comments nor age1… recipients"
  fi
}

# bk_aws …: the box has no AWS CLI on the host. Use it when present, otherwise
# the pinned official CLI image (docker is already on the box). Credentials and
# region pass by NAME only (values never appear on a command line).
# Paths given to the CLI must sit under BK_AWS_MOUNT (mounted at the same path).
BACKUP_AWS_CLI_IMAGE="${BACKUP_AWS_CLI_IMAGE:-amazon/aws-cli:2.17.0}"
bk_aws() {
  if command -v aws >/dev/null 2>&1; then
    aws "$@"
  else
    [ -n "${BK_AWS_MOUNT:-}" ] || bk_die "internal: BK_AWS_MOUNT unset for containerised aws"
    docker run --rm -i \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
      -e AWS_REGION -e AWS_DEFAULT_REGION -e AWS_ENDPOINT_URL \
      -v "${BK_AWS_MOUNT}:${BK_AWS_MOUNT}" \
      "$BACKUP_AWS_CLI_IMAGE" "$@"
  fi
}

# --- S3 uploads (M-A8 §1.1.4) ------------------------------------------------
# Every upload names SSE-KMS and THIS bucket's key explicitly
# (x-amz-server-side-encryption: aws:kms + x-amz-server-side-encryption-aws-kms-key-id);
# the bucket policy denies any PutObject without both. Uploads are single PUTs
# (s3api put-object): an UploadPart request carries no SSE header, so the bucket
# policy refuses multipart by design, and the writer holds no kms:Decrypt (which
# multipart would need). A single PUT is capped at 5 GiB.
# The object's SHA-256 checksum is computed by the CLI, checked by S3, and compared
# here with the local file, so a returned upload is a VERIFIED copy of these bytes.
BK_S3_MAX_PUT_BYTES=5368709120

bk_s3_bucket() {
  local uri="$1"
  [[ "$uri" =~ ^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] ||
    bk_die "BACKUP_S3_URI must be s3://<bucket> (prefixes are fixed by these scripts; got '${uri}')" 2
  printf '%s\n' "${uri#s3://}"
}

bk_require_kms_key() {
  [ -n "${BACKUP_KMS_KEY_ID:-}" ] ||
    bk_die "BACKUP_KMS_KEY_ID is unset: every upload must name the bucket's KMS key (terraform output backup_kms_key_arn)" 2
}

# base64 of the raw SHA-256 digest (the form S3 returns as ChecksumSHA256).
bk_sha256_b64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -binary "$1" | base64 | tr -d '\n'
  else
    python3 -c 'import base64,hashlib,sys; print(base64.b64encode(hashlib.sha256(open(sys.argv[1],"rb").read()).digest()).decode())' "$1"
  fi
}

# bk_s3_put <file> <bucket> <key> [metadata k=v,k=v]  → prints the S3 VersionId.
bk_s3_put() {
  local file="$1" bucket="$2" key="$3" meta="${4:-}" size want out got version
  bk_require_kms_key
  [[ "$key" =~ ^(routine|historic|heartbeat|restore-checks)/[A-Za-z0-9._/-]+$ ]] ||
    bk_die "refusing upload key outside the fixed prefixes: ${key}"
  size="$(bk_size "$file")"
  [ "$size" -le "$BK_S3_MAX_PUT_BYTES" ] ||
    bk_die "$(basename "$file") is ${size} bytes; a single PUT is limited to 5 GiB (multipart is refused by the bucket policy)"
  want="$(bk_sha256_b64 "$file")"
  local -a args=(s3api put-object --bucket "$bucket" --key "$key" --body "$file"
    --server-side-encryption aws:kms --ssekms-key-id "$BACKUP_KMS_KEY_ID"
    --checksum-algorithm SHA256 --query '[ChecksumSHA256,VersionId]' --output text)
  if [ -n "$meta" ]; then args+=(--metadata "$meta"); fi
  out="$(BK_AWS_MOUNT="$(cd "$(dirname "$file")" && pwd -P)" bk_aws "${args[@]}")" ||
    bk_die "upload FAILED: s3://${bucket}/${key}"
  got="$(printf '%s' "$out" | awk -F'\t' 'NR==1{print $1}')"
  version="$(printf '%s' "$out" | awk -F'\t' 'NR==1{print $2}')"
  [ "$got" = "$want" ] ||
    bk_die "upload checksum mismatch for s3://${bucket}/${key} (local ${want}, S3 ${got:-none})"
  printf '%s\n' "${version:-null}"
}

# bk_heartbeat <status OK|FAILED> <run_id> <label> <databases> <artifacts> <bytes> [source]
# Writes $BACKUP_DIR/heartbeat/<run_id>.json (0600; counts only, never data) and,
# when BACKUP_S3_URI is set, uploads it to heartbeat/<run_id>.json with the status in
# object metadata (the freshness Lambda reads metadata, never the body).
bk_heartbeat() {
  local status="$1" run_id="$2" label="$3" dbs="$4" arts="$5" bytes="$6" source="${7:-aramo-backup.sh}"
  case "$status" in OK | FAILED) ;; *) bk_die "heartbeat status must be OK or FAILED" 2 ;; esac
  [[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$ ]] || bk_die "invalid heartbeat run_id: ${run_id}" 2
  [[ "$source" =~ ^[A-Za-z0-9@._-]{1,100}$ ]] || source="unknown"
  local dir="$BACKUP_DIR/heartbeat" f
  bk_private_dir "$BACKUP_DIR"
  bk_private_dir "$dir"
  f="$dir/${run_id}.json"
  printf '{"schema":1,"status":"%s","run_id":"%s","label":"%s","source":"%s","host":"%s","created_at":"%s","databases":%s,"artifacts":%s,"bytes":%s}\n' \
    "$status" "$run_id" "$label" "$source" "$(hostname)" "$(bk_now_iso)" "${dbs:-0}" "${arts:-0}" "${bytes:-0}" >"$f"
  chmod 600 "$f"
  if [ -n "${BACKUP_S3_URI:-}" ]; then
    bk_s3_put "$f" "$(bk_s3_bucket "$BACKUP_S3_URI")" "heartbeat/${run_id}.json" "status=${status},run-id=${run_id}" >/dev/null
    bk_log "heartbeat ${status} uploaded: heartbeat/${run_id}.json"
  else
    bk_log "heartbeat ${status} written locally only (BACKUP_S3_URI unset): ${f}"
  fi
}

# --- manifest (TSV; counts + hashes only, never row content) ----------------
# Line 1: "# aramo-backup manifest v<N>"; then key=value header lines; then one
# "artifact" line per file:
#   artifact <file> <db> <format> <size> <sha256> <table_count> <ledger_table> <ledger_count> <source_sha256> <source_name>
# "-" marks a value not recorded (e.g. counts for an encrypted historic dump).
bk_manifest_header() {
  printf '# aramo-backup manifest v%s\n' "$BK_MANIFEST_VERSION"
}

bk_manifest_kv() { printf '%s=%s\n' "$1" "$2"; }

bk_manifest_artifact() {
  printf 'artifact\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@"
}

bk_manifest_get() { awk -F= -v k="$2" '$1==k {sub(/^[^=]*=/, ""); print; exit}' "$1"; }

bk_manifest_check() {
  head -1 "$1" | grep -q "^# aramo-backup manifest v${BK_MANIFEST_VERSION}\$" ||
    bk_die "not an aramo-backup v${BK_MANIFEST_VERSION} manifest: $1"
}
