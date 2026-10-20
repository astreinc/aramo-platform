#!/usr/bin/env bash
# tools/sign-naming/naming.pg-integration.sh — REAL-PostgreSQL proof of the Sign
# naming unification migrations (Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED
# §3.1, §3.2, §3.5) on the REAL migration manifest.
#
# Run:  bash tools/sign-naming/naming.pg-integration.sh [<pre-rename-git-ref>]
#   <pre-rename-git-ref> defaults to origin/main (a tree that still has libs/esign).
#   ARAMO_PG_IMAGE (default pgvector/pgvector:pg17)  ARAMO_PG_PORT (default 55433)
#
# Cases:
#   N1 fresh database: the full replay creates esign and the naming migrations move it
#      to sign; the ledger holds only libs/sign paths; a second run applies 0
#   N2 production-shaped upgrade: a database built by the PRE-rename tree (ledger under
#      libs/esign, live esign data) upgrades with the new tree: the guarded re-key runs,
#      ONLY the new migrations apply (no historical DDL replays), every identifier is
#      renamed, and history (delivered outbox rows) is untouched
#   N3 partial states are REFUSED with nothing changed: (a) legacy + renamed ledger rows
#      both present, (b) legacy rows but the schema was already renamed by hand
#   N4 idempotent: re-running the new tree on the upgraded database applies 0
#   N5 reverse then forward: reverse.sql restores the pre-rename names and ledger (the
#      pre-rename tree then reports 0 pending), and the forward run repeats the cutover
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OLD_REF="${1:-origin/main}"
IMAGE="${ARAMO_PG_IMAGE:-pgvector/pgvector:pg17}"
PORT="${ARAMO_PG_PORT:-55433}"
CNAME="aramo-sign-naming-pg-$$"

PSQL="$(command -v psql || true)"
[ -z "$PSQL" ] && [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
[ -n "$PSQL" ] || { echo "naming-pg: psql not found"; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "naming-pg: docker not found"; exit 2; }

TMP="$(mktemp -d)"
cleanup() { docker rm -f "$CNAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "  ok    $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# The pre-rename tree (only what the runner needs: tools + every lib's migrations).
OLD="$TMP/old"; mkdir -p "$OLD"
git -C "$ROOT" archive "$OLD_REF" tools/db-sync-local.sh libs | tar -x -C "$OLD" \
  || { echo "naming-pg: cannot export ${OLD_REF}"; exit 2; }
[ -d "$OLD/libs/esign/prisma/migrations" ] || { echo "naming-pg: ${OLD_REF} has no libs/esign (not a pre-rename tree)"; exit 2; }

echo "naming-pg: starting ${IMAGE} on 127.0.0.1:${PORT}"
docker run -d --rm --name "$CNAME" -e POSTGRES_PASSWORD=pg -e POSTGRES_USER=pg -e POSTGRES_DB=postgres \
  -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
ADMIN="postgresql://pg:pg@127.0.0.1:${PORT}/postgres"
for _ in $(seq 1 60); do "$PSQL" "$ADMIN" -tAc "select 1" >/dev/null 2>&1 && break; sleep 1; done
"$PSQL" "$ADMIN" -tAc "select 1" >/dev/null 2>&1 || { echo "naming-pg: postgres did not come up"; exit 2; }

mkdb() { "$PSQL" "$ADMIN" -qc "CREATE DATABASE $1;" >/dev/null; printf 'postgresql://pg:pg@127.0.0.1:%s/%s' "$PORT" "$1"; }
clone() { "$PSQL" "$ADMIN" -qc "CREATE DATABASE $2 TEMPLATE $1;" >/dev/null; printf 'postgresql://pg:pg@127.0.0.1:%s/%s' "$PORT" "$2"; }
v() { "$PSQL" "$1" -tAc "$2" 2>&1; }
sync_old() { DATABASE_URL="$1" bash "$OLD/tools/db-sync-local.sh" "${@:2}" 2>&1; }
sync_new() { DATABASE_URL="$1" bash "$ROOT/tools/db-sync-local.sh" "${@:2}" 2>&1; }
applied_names() { printf '%s\n' "$1" | sed -n 's/^  applied  //p' | sort | tr '\n' ' ' | sed 's/ $//'; }

NEW_ONLY="$(comm -13 <(cd "$OLD" && ls -d libs/*/prisma/migrations/*/ | sed 's#libs/esign/#libs/sign/#' | sort) \
                     <(cd "$ROOT" && ls -d libs/*/prisma/migrations/*/ | sort) | awk -F/ '{print $(NF-1)}' | sort | tr '\n' ' ' | sed 's/ $//')"
echo "naming-pg: migrations new in this tree: ${NEW_ONLY}"

# ── N1 fresh ─────────────────────────────────────────────────────────────────
echo "N1 fresh database"
D1="$(mkdb n1)"
out="$(sync_new "$D1")"; rc=$?
check "N1 full replay exits 0" "[ $rc -eq 0 ]"
[ $rc -eq 0 ] || printf '%s\n' "$out" | tail -8
check "N1 schema sign exists, esign absent" "[ \"\$(v \"$D1\" \"SELECT to_regnamespace('sign') IS NOT NULL AND to_regnamespace('esign') IS NULL\")\" = t ]"
check "N1 capability enum has sign, not esign" "[ \"\$(v \"$D1\" \"SELECT string_agg(enumlabel, ',' ORDER BY enumlabel) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='Capability' AND enumlabel IN ('sign','esign')\")\" = sign ]"
check "N1 ledger has no libs/esign rows" "[ \"\$(v \"$D1\" \"SELECT count(*) FROM public._local_migrations WHERE name LIKE 'libs/esign/%'\")\" = 0 ]"
check "N1 subscription keys are sign.*" "[ \"\$(v \"$D1\" \"SELECT count(*) FROM subscription.\\\"PlanAllowance\\\" WHERE allowance_key LIKE 'esign.%'\")\" = 0 ] && [ \"\$(v \"$D1\" \"SELECT count(*) FROM subscription.\\\"PlanAllowance\\\" WHERE allowance_key LIKE 'sign.%'\")\" -gt 0 ]"
check "N1 aramo-ats permissions are sign:*" "[ \"\$(v \"$D1\" \"SELECT bool_and(p LIKE 'sign:%') FROM sign.\\\"SignApplication\\\", unnest(requested_permissions) p WHERE key='aramo-ats'\")\" = t ]"
check "N1 erasure guard names sign.EnvelopeDocument" "v \"$D1\" \"SELECT prosrc FROM pg_proc WHERE proname='reject_document_event_mutation'\" | grep -q 'sign.\"EnvelopeDocument\"' && ! v \"$D1\" \"SELECT prosrc FROM pg_proc WHERE proname='reject_document_event_mutation'\" | grep -q 'esign\.'"
check "N1 Sign append-only trigger moved with the schema" "[ \"\$(v \"$D1\" \"SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='sign' AND tg.tgname='signature_event_append_only'\")\" = 1 ]"
out="$(sync_new "$D1")"
check "N1 second run applies 0" "printf '%s' \"\$out\" | grep -q '— 0 applied'"

# ── N2 production-shaped upgrade ─────────────────────────────────────────────
echo "N2 production-shaped upgrade"
DOLD="$(mkdb n2old)"
out="$(sync_old "$DOLD")"; rc=$?
check "N2 pre-rename tree builds the old world" "[ $rc -eq 0 ]"
[ $rc -eq 0 ] || printf '%s\n' "$out" | tail -8
T=019a9999-0000-7000-8000-0000000000aa
v "$DOLD" "
INSERT INTO identity.\"Role\" (id, key, description, is_active, created_at, updated_at) VALUES ('019a9999-0000-7000-8000-000000000001','esign_owner','E-Sign Owner — x',true,now(),now()), ('019a9999-0000-7000-8000-000000000002','recruiter','Recruiter — x',true,now(),now());
INSERT INTO identity.\"Scope\" (id, key, description, created_at) VALUES ('019a9999-0000-7000-8000-000000000003','esign:envelope:read','r',now()), ('019a9999-0000-7000-8000-000000000004','talent:read','r',now());
INSERT INTO entitlement.\"TenantEntitlement\" (tenant_id, capability) VALUES ('$T','esign');
INSERT INTO auth_storage.\"RefreshToken\" (id, user_id, tenant_id, consumer_type, token_hash, updated_at, expires_at) VALUES ('019a9999-0000-7000-8000-000000000005','019a9999-0000-7000-8000-000000000006','$T','esign','h1',now(),now()+interval '1 day'), ('019a9999-0000-7000-8000-000000000007','019a9999-0000-7000-8000-000000000006','$T','recruiter','h2',now(),now()+interval '1 day');
INSERT INTO esign.\"SignWebhookSubscription\" (id, application_id, target_url, event_types, secret_ciphertext, internal) SELECT '019a9999-0000-7000-8000-000000000008', id, 'http://api:3000/v1/integrations/esign/events', ARRAY['esign.envelope.executed.v1'], 'c', true FROM esign.\"SignApplication\" WHERE key='aramo-ats';
INSERT INTO esign.\"OutboxEvent\" (id, tenant_id, event_type, event_payload) VALUES ('019a9999-0000-7000-8000-000000000009','$T','esign.envelope.executed.v1','{}');
" >/dev/null
check "N2 old world seeded (legacy ledger rows = 11)" "[ \"\$(v \"$DOLD\" \"SELECT count(*) FROM public._local_migrations WHERE name LIKE 'libs/esign/%'\")\" = 11 ]"
"$PSQL" "$ADMIN" -qc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='n2old' AND pid <> pg_backend_pid();" >/dev/null
D2="$(clone n2old n2)"
out="$(sync_new "$D2")"; rc=$?
check "N2 upgrade exits 0" "[ $rc -eq 0 ]"
[ $rc -eq 0 ] || printf '%s\n' "$out" | tail -10
check "N2 guarded re-key ran (11 rows)" "printf '%s' \"\$out\" | grep -q 're-keyed 11 historical Sign migration'"
check "N2 ONLY the new migrations applied (no historical replay)" "[ \"\$(applied_names \"\$out\")\" = \"$NEW_ONLY\" ]"
check "N2 schema renamed" "[ \"\$(v \"$D2\" \"SELECT to_regnamespace('sign') IS NOT NULL AND to_regnamespace('esign') IS NULL\")\" = t ]"
check "N2 tenant entitlement follows the enum (sign)" "[ \"\$(v \"$D2\" \"SELECT capability FROM entitlement.\\\"TenantEntitlement\\\" WHERE tenant_id='$T'\")\" = sign ]"
check "N2 role + scope keys renamed, others untouched" "[ \"\$(v \"$D2\" \"SELECT string_agg(key, ',' ORDER BY key) FROM identity.\\\"Role\\\" WHERE id::text LIKE '019a9999%'\")\" = recruiter,sign_owner ] && [ \"\$(v \"$D2\" \"SELECT string_agg(key, ',' ORDER BY key) FROM identity.\\\"Scope\\\" WHERE id::text LIKE '019a9999%'\")\" = sign:envelope:read,talent:read ]"
check "N2 live esign refresh token revoked, recruiter token untouched" "[ \"\$(v \"$D2\" \"SELECT string_agg(consumer_type || ':' || (revoked_at IS NOT NULL)::text, ',' ORDER BY consumer_type) FROM auth_storage.\\\"RefreshToken\\\" WHERE tenant_id='$T'\")\" = esign:true,recruiter:false ]"
check "N2 first-party subscription follows the receiver path + event names" "[ \"\$(v \"$D2\" \"SELECT target_url || '|' || array_to_string(event_types, ',') FROM sign.\\\"SignWebhookSubscription\\\" WHERE id='019a9999-0000-7000-8000-000000000008'\")\" = 'http://api:3000/v1/integrations/sign/events|sign.envelope.executed.v1' ]"
check "N2 historical outbox row NOT rewritten" "[ \"\$(v \"$D2\" \"SELECT event_type FROM sign.\\\"OutboxEvent\\\" WHERE id='019a9999-0000-7000-8000-000000000009'\")\" = esign.envelope.executed.v1 ]"
check "N2 Sign role CHECK constraints carry sign_* only" "[ \"\$(v \"$D2\" \"SELECT string_agg(pg_get_constraintdef(oid), ' ') FROM pg_constraint WHERE conname IN ('SignInstallation_role_check','SignRoleMapping_sign_role_check')\" | grep -c 'esign_')\" = 0 ] && v \"$D2\" \"SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='SignRoleMapping_sign_role_check'\" | grep -q sign_admin"
check "N2 subscription keys renamed" "[ \"\$(v \"$D2\" \"SELECT count(*) FROM subscription.\\\"PlanAllowance\\\" WHERE allowance_key LIKE 'esign.%'\")\" = 0 ]"
st="$(sync_new "$D2" --status)"
check "N2 status reports 0 pending" "printf '%s' \"\$st\" | grep -q 'pending — 0 on-disk'"

# ── N3 partial states refused ────────────────────────────────────────────────
echo "N3 partial states refused"
D3A="$(clone n2old n3a)"
v "$D3A" "INSERT INTO public._local_migrations(name) VALUES ('libs/sign/prisma/migrations/20261019200000_sign_event_bound_grants/');" >/dev/null
before="$(v "$D3A" "SELECT string_agg(name, ',' ORDER BY name) FROM public._local_migrations")"
out="$(sync_new "$D3A")"; rc=$?
check "N3a legacy + renamed rows → refused (exit 3)" "[ $rc -eq 3 ]"
check "N3a ledger unchanged" "[ \"\$(v \"$D3A\" \"SELECT string_agg(name, ',' ORDER BY name) FROM public._local_migrations\")\" = \"\$before\" ]"
check "N3a schema unchanged (esign)" "[ \"\$(v \"$D3A\" \"SELECT to_regnamespace('esign') IS NOT NULL AND to_regnamespace('sign') IS NULL\")\" = t ]"
D3B="$(clone n2old n3b)"
v "$D3B" 'ALTER SCHEMA "esign" RENAME TO "sign";' >/dev/null
out="$(sync_new "$D3B")"; rc=$?
check "N3b legacy rows but schema already renamed → refused (exit 3)" "[ $rc -eq 3 ]"
check "N3b ledger still legacy (11), nothing applied" "[ \"\$(v \"$D3B\" \"SELECT count(*) FROM public._local_migrations WHERE name LIKE 'libs/esign/%'\")\" = 11 ] && ! printf '%s' \"\$out\" | grep -q '^  applied'"

# ── N4 idempotent ────────────────────────────────────────────────────────────
echo "N4 idempotent re-run"
out="$(sync_new "$D2")"; rc=$?
check "N4 re-run exits 0 and applies 0" "[ $rc -eq 0 ] && printf '%s' \"\$out\" | grep -q '— 0 applied' && ! printf '%s' \"\$out\" | grep -q 're-keyed'"

# ── N5 reverse then forward ──────────────────────────────────────────────────
echo "N5 reverse then forward"
"$PSQL" "$D2" -v ON_ERROR_STOP=1 --single-transaction -q -f "$ROOT/tools/sign-naming/reverse.sql" >/dev/null 2>"$TMP/rev.err"; rc=$?
check "N5 reverse.sql exits 0" "[ $rc -eq 0 ]"
[ $rc -eq 0 ] || cat "$TMP/rev.err"
check "N5 names restored (esign schema, enum, keys)" "[ \"\$(v \"$D2\" \"SELECT to_regnamespace('esign') IS NOT NULL AND to_regnamespace('sign') IS NULL\")\" = t ] && [ \"\$(v \"$D2\" \"SELECT capability FROM entitlement.\\\"TenantEntitlement\\\" WHERE tenant_id='$T'\")\" = esign ] && [ \"\$(v \"$D2\" \"SELECT key FROM identity.\\\"Role\\\" WHERE id='019a9999-0000-7000-8000-000000000001'\")\" = esign_owner ]"
st="$(sync_old "$D2" --status)"
check "N5 the pre-rename tree reports 0 pending (old images could run)" "printf '%s' \"\$st\" | grep -q 'pending — 0 on-disk'"
"$PSQL" "$D2" -v ON_ERROR_STOP=1 --single-transaction -q -f "$ROOT/tools/sign-naming/reverse.sql" >/dev/null 2>&1; rc=$?
check "N5 a second reverse is refused (precondition)" "[ $rc -ne 0 ]"
out="$(sync_new "$D2")"; rc=$?
check "N5 forward again: re-key + the six naming migrations" "[ $rc -eq 0 ] && printf '%s' \"\$out\" | grep -q 're-keyed 11' && [ \"\$(printf '%s\n' \"\$out\" | grep -c '^  applied  20261020130')\" = 6 ]"
check "N5 forward again: renamed" "[ \"\$(v \"$D2\" \"SELECT to_regnamespace('sign') IS NOT NULL AND to_regnamespace('esign') IS NULL\")\" = t ]"

echo "naming-pg: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
