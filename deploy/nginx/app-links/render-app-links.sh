#!/bin/sh
#
# deploy/nginx/app-links/render-app-links.sh
#
# Aramo Sign Mobile (Native Application Implementation Directive v1.0 LOCKED §4 B-13,
# §14 P-1/P-3/P-6; Amendment M-A2 §3) — renders the two platform app-association
# files the Sign host serves at its exact `/.well-known/` locations:
#
#   apple-app-site-association   iOS Universal Links (applinks)
#   assetlinks.json              Android App Links (Digital Asset Links)
#
# Installed into the official nginx image as /docker-entrypoint.d/40-aramo-app-links.sh,
# so it runs at EVERY container start (after 20-envsubst-on-templates.sh) whenever the
# entrypoint is entered with `nginx` (the compose command chains through
# `/docker-entrypoint.sh nginx`, E18). It is a dedicated render step on purpose: the
# conf template's envsubst stays filtered to ^NGINX_ and never sees these vars.
#
# Inputs (container env; all optional):
#   SIGN_IOS_APP_ID            <TEAMID>.<bundle id>, e.g. ABCDE12345.ai.aramo.sign
#   SIGN_ANDROID_PACKAGE       Android application id, e.g. ai.aramo.sign
#   SIGN_ANDROID_CERT_SHA256S  comma list of SHA-256 signing-cert fingerprints
#                              (AA:BB:… 32 colon-separated hex pairs; case-insensitive)
#   ARAMO_APP_LINKS_DIR        output dir (default /etc/nginx/aramo-app-links)
#
# Fail-safe contract: an unset OR malformed value renders VALID JSON THAT ASSOCIATES
# NOTHING (iOS: an empty `details` list; Android: an empty statement list) and logs a
# warning. The front door never crash-loops over mobile configuration, and an invalid
# value can never be published as a partial association. Every accepted value is
# validated against a strict character class first, so nothing a JSON string would
# need to escape can reach the output.
#
# POSIX sh only (busybox ash in nginx:stable-alpine; also runs under macOS/Linux sh for
# the conf-check self-test).

set -eu
# No pathname expansion: the comma-list split below must never glob.
set -f

OUT_DIR="${ARAMO_APP_LINKS_DIR:-/etc/nginx/aramo-app-links}"
IOS_APP_ID="${SIGN_IOS_APP_ID:-}"
ANDROID_PACKAGE="${SIGN_ANDROID_PACKAGE:-}"
ANDROID_CERTS="${SIGN_ANDROID_CERT_SHA256S:-}"

log() {
  echo "40-aramo-app-links: $*" >&2
}

# Universal Link paths (M-A2 §3.1): guest signing /s/*, /d/*, and the native auth
# callback. Nothing else on the host opens the app.
AASA_COMPONENTS='{"/":"/s/*","comment":"guest signing link"},{"/":"/d/*","comment":"guest signing link"},{"/":"/auth/native/callback","comment":"native sign-in callback"}'

mkdir -p "$OUT_DIR"

# ── iOS ──────────────────────────────────────────────────────────────────────
ios_json='{"applinks":{"details":[]}}'
if [ -n "$IOS_APP_ID" ]; then
  # Team ID: 10 uppercase alphanumerics; bundle id: reverse-DNS segments.
  if printf '%s' "$IOS_APP_ID" | grep -Eq '^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'; then
    ios_json="{\"applinks\":{\"details\":[{\"appIDs\":[\"$IOS_APP_ID\"],\"components\":[$AASA_COMPONENTS]}]}}"
    log "apple-app-site-association: associated $IOS_APP_ID"
  else
    log "WARNING: SIGN_IOS_APP_ID is not <TEAMID>.<bundle id>; rendering an empty association"
  fi
else
  log "apple-app-site-association: SIGN_IOS_APP_ID unset; rendering an empty association"
fi

# ── Android ──────────────────────────────────────────────────────────────────
android_json='[]'
if [ -n "$ANDROID_PACKAGE" ] && [ -n "$ANDROID_CERTS" ]; then
  if printf '%s' "$ANDROID_PACKAGE" | grep -Eq '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'; then
    fps=''
    bad=0
    # Split the comma list; trim spaces; uppercase; validate each fingerprint.
    for raw in $(printf '%s' "$ANDROID_CERTS" | tr ',' ' '); do
      fp="$(printf '%s' "$raw" | tr -d '[:space:]' | tr 'abcdef' 'ABCDEF')"
      [ -z "$fp" ] && continue
      if printf '%s' "$fp" | grep -Eq '^([0-9A-F]{2}:){31}[0-9A-F]{2}$'; then
        if [ -z "$fps" ]; then fps="\"$fp\""; else fps="$fps,\"$fp\""; fi
      else
        bad=1
      fi
    done
    if [ "$bad" -eq 1 ] || [ -z "$fps" ]; then
      log "WARNING: SIGN_ANDROID_CERT_SHA256S has an invalid fingerprint; rendering an empty association"
    else
      android_json="[{\"relation\":[\"delegate_permission/common.handle_all_urls\"],\"target\":{\"namespace\":\"android_app\",\"package_name\":\"$ANDROID_PACKAGE\",\"sha256_cert_fingerprints\":[$fps]}}]"
      log "assetlinks.json: associated $ANDROID_PACKAGE"
    fi
  else
    log "WARNING: SIGN_ANDROID_PACKAGE is not a valid application id; rendering an empty association"
  fi
else
  log "assetlinks.json: SIGN_ANDROID_PACKAGE or SIGN_ANDROID_CERT_SHA256S unset; rendering an empty association"
fi

# Write atomically (a reload never serves a half-written file).
printf '%s\n' "$ios_json" > "$OUT_DIR/.apple-app-site-association.tmp"
mv -f "$OUT_DIR/.apple-app-site-association.tmp" "$OUT_DIR/apple-app-site-association"
printf '%s\n' "$android_json" > "$OUT_DIR/.assetlinks.json.tmp"
mv -f "$OUT_DIR/.assetlinks.json.tmp" "$OUT_DIR/assetlinks.json"
