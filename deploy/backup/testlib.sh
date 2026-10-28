# shellcheck shell=bash
# Shared helpers for deploy/backup/*.test.sh. Sourced, never run. Needs $T (a
# private temp dir) set by the caller.
#
#   tl_setup_age      put real age on PATH, or shim it through ARAMO_TEST_AGE_IMAGE
#   tl_setup_fake_s3  put a FAKE `aws` first on PATH (never the real CLI, never AWS):
#                     an on-disk bucket under $FAKE_S3 that enforces the M-A8 bucket
#                     policy (SSE aws:kms + the expected key id on every put, single
#                     PUT only), records every call in $FAKE_S3/calls.log, stores
#                     object metadata, returns ChecksumSHA256 + VersionId like S3.

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

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
sha_of() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | awk '{print $1}'; }

tl_setup_age() {
  mkdir -p "$T/bin"
  if command -v age >/dev/null 2>&1 && command -v age-keygen >/dev/null 2>&1; then
    return 0
  fi
  [ -n "${ARAMO_TEST_AGE_IMAGE:-}" ] || {
    echo "age not installed and ARAMO_TEST_AGE_IMAGE unset" >&2
    exit 2
  }
  local b
  for b in age age-keygen; do
    cat >"$T/bin/$b" <<EOF
#!/usr/bin/env bash
exec docker run --rm -i -u "\$(id -u):\$(id -g)" -v "$T:$T" -w "\$PWD" "$ARAMO_TEST_AGE_IMAGE" $b "\$@"
EOF
    chmod +x "$T/bin/$b"
  done
  export PATH="$T/bin:$PATH"
  echo "  (age shimmed via ${ARAMO_TEST_AGE_IMAGE})"
}

TL_KMS_KEY="arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-00000000test"

tl_setup_fake_s3() {
  export FAKE_S3="$T/fake-s3"
  export FAKE_S3_KMS_KEY="$TL_KMS_KEY"
  mkdir -p "$FAKE_S3" "$T/fakeaws"
  : >"$FAKE_S3/calls.log"
  cat >"$T/fakeaws/aws" <<'EOF'
#!/usr/bin/env bash
# FAKE aws CLI for the backup tests (no network, no AWS).
set -uo pipefail
printf '%s\n' "$*" >>"$FAKE_S3/calls.log"
deny() { echo "An error occurred (AccessDenied) when calling the PutObject operation: $1" >&2; exit 254; }
b64sha() { openssl dgst -sha256 -binary "$1" | base64 | tr -d '\n'; }
if [ "${1:-}" = "s3api" ] && [ "${2:-}" = "put-object" ]; then
  shift 2
  bucket="" key="" body="" sse="" kms="" meta="" ck=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --bucket) bucket="$2"; shift 2 ;;
      --key) key="$2"; shift 2 ;;
      --body) body="$2"; shift 2 ;;
      --server-side-encryption) sse="$2"; shift 2 ;;
      --ssekms-key-id) kms="$2"; shift 2 ;;
      --metadata) meta="$2"; shift 2 ;;
      --checksum-algorithm) ck="$2"; shift 2 ;;
      --query | --output) shift 2 ;;
      *) echo "fake aws: unexpected argument $1" >&2; exit 2 ;;
    esac
  done
  # The M-A8 bucket policy: SSE header present AND aws:kms, key id present AND this key.
  [ -n "$sse" ] || deny "missing x-amz-server-side-encryption"
  [ "$sse" = "aws:kms" ] || deny "server-side encryption is not aws:kms"
  [ -n "$kms" ] || deny "missing x-amz-server-side-encryption-aws-kms-key-id"
  [ "$kms" = "$FAKE_S3_KMS_KEY" ] || deny "wrong KMS key"
  [ "$ck" = "SHA256" ] || { echo "fake aws: expected --checksum-algorithm SHA256" >&2; exit 2; }
  [ -f "$body" ] || { echo "fake aws: body not found $body" >&2; exit 2; }
  mkdir -p "$(dirname "$FAKE_S3/$bucket/$key")" "$(dirname "$FAKE_S3/.meta/$bucket/$key")"
  cp "$body" "$FAKE_S3/$bucket/$key"
  printf '%s\n' "$meta" >"$FAKE_S3/.meta/$bucket/$key"
  sum="$(b64sha "$body")"
  [ "${FAKE_S3_CORRUPT:-0}" != 1 ] || sum="AAAA${sum#????}"
  printf '%s\t%s\n' "$sum" "v$(date +%s)$RANDOM"
  exit 0
fi
if [ "${1:-}" = "s3" ] && [ "${2:-}" = "cp" ]; then
  shift 2
  rec=0 src="" dst=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --recursive) rec=1; shift ;;
      --only-show-errors) shift ;;
      *) if [ -z "$src" ]; then src="$1"; else dst="$1"; fi; shift ;;
    esac
  done
  [ "$rec" = 1 ] && [[ "$src" == s3://* ]] || { echo "fake aws: only recursive downloads are supported" >&2; exit 2; }
  path="$FAKE_S3/${src#s3://}"
  [ -d "$path" ] || { echo "fake aws: no such prefix $src" >&2; exit 1; }
  mkdir -p "$dst"
  cp -R "${path%/}/." "$dst"
  exit 0
fi
echo "fake aws: unsupported command: $*" >&2
exit 2
EOF
  chmod +x "$T/fakeaws/aws"
  export PATH="$T/fakeaws:$PATH"
}

# fake_meta <bucket> <key> → the metadata string stored with the object
fake_meta() { cat "$FAKE_S3/.meta/$1/$2" 2>/dev/null; }
