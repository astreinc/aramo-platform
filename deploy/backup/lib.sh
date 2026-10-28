# shellcheck shell=bash
# Aramo backup tooling — shared helpers (M-A7 §2 / R-15). Sourced, never run.
#
# Sourced by aramo-backup.sh, aramo-backup-prune.sh, aramo-restore-test.sh,
# aramo-backup-encrypt-existing.sh, aramo-deletion-replay.sh and pg-restore.sh.
# Portable across the box (Ubuntu 24.04, GNU coreutils, bash 5) and the
# operator Mac (BSD stat/shasum, bash 3.2) because restore tests run on the Mac:
# the age IDENTITY (private key) never exists on the box.

# Manifest format version. Bump on any column change in bk_manifest_artifact.
BK_MANIFEST_VERSION=1

bk_log() { printf '%s: %s\n' "${BK_TAG:-aramo-backup}" "$*" >&2; }

bk_die() {
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
  [ -s "$f" ] || bk_die "recipients file missing or empty: ${f} (see doc/runbooks/RUNBOOK-backups-r15.md §Key custody)"
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
