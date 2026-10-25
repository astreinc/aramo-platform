# Runbook — CCP dark-state verification (PBD §7.3, Conv. C-26…C-28)

> **Design approval is not production migration authority (ruling A0-C15).** This runbook only reads.
> It changes no switch. **Running it against production needs separate PO authorization** (it reads
> production configuration and data), and turning any switch on needs its own release authorization (§12).

**Status:** operator procedure (CCP-D5); the release-evidence step named by CCP-D6. **Owner:** the release lead.
**Governing text:** Program Build Directive §7.3 (ruling A0-C9), §12; Conversion Rule C-26, C-27, C-28.
**Dry run:** `doc/ccp/runbook-dry-runs-20261025.md` §5.

## 1. Why

PBD §7.3, verbatim:

> - Live Stripe billing and public signup SHALL remain disabled in production until the A6 guard and the C1/C2 reconciliation path are **delivered, validated and separately release-authorized** by the PO (Conv. C-26).
> - The dark state SHALL be **re-verified** against production before any production activation, and recorded as release evidence (Conv. C-27).
> - This ruling **does not itself establish that the switches are off** (Conv. C-28).

So no document, memory note or earlier run is evidence of the current state. Run this before every production
activation and record its output.

## 2. Expected dark state

| Control | Where it is read | Expected |
|---|---|---|
| Public business signup | `SIGN_PUBLIC_SIGNUP_ENABLED` (platform-admin; on only when exactly `1`) | UNSET |
| Personal (Free) | `SIGN_PERSONAL_SIGNUP_MODE` (platform-admin and sign; on when `invite` or `open`) | UNSET |
| Live Stripe | `STRIPE_SECRET_KEY` prefix (sign); `sk_live_` / `rk_live_` is live | TEST or UNSET, never LIVE |
| Stripe key in platform-admin | `STRIPE_SECRET_KEY` (not passed by `docker-compose.prod.yml`; C3 stays NOT DELIVERED) | UNSET |
| Checkout | `STRIPE_PLAN_PRICES` empty (sign) **and** no `PlanVersionPrice` pin | UNSET and 0 pins |
| Stripe command worker | `SIGN_BILLING_COMMANDS_ENABLED` (sign) | UNSET |
| Astre MANUAL intact | the data row: MANUAL, ACTIVE, `aramo-sign-included-v1`, no provider link | one row |

The check prints a class only: **SET / UNSET** for switches and lists, **TEST / LIVE / UNSET** for the Stripe key.
It never prints a value. It reads both the running container (what is in force) and `/opt/aramo/.env` (what the
next recreate would apply); both must match the expected class.

## 3. Configuration check (read-only)

```bash
cat > /tmp/ccp-dark-state-check.sh <<'SH'
#!/usr/bin/env bash
# CCP dark-state verification (PBD §7.3). READ-ONLY. Prints a class per control, never a value.
# Classes: SET / UNSET for switches and lists; TEST / LIVE / UNSET for the Stripe key.
set -uo pipefail
SUDO="${SUDO-sudo}"
SIGN_C="${SIGN_C:-aramo-prod-sign}"
PA_C="${PA_C:-aramo-prod-platform-admin}"
ENV_FILE="${ENV_FILE:-/opt/aramo/.env}"

# $1 container, $2 variable, $3 class rule: flag (SET only when exactly 1) | mode (SET when invite|open)
#   | list (SET when non-empty) | stripe (TEST / LIVE / UNSET / SET for an unrecognised prefix)
cls_container() {
  $SUDO docker exec "$1" sh -c '
    v="$(printenv "$1" 2>/dev/null || true)"
    case "$2" in
      flag)   [ "$v" = "1" ] && echo SET || echo UNSET ;;
      mode)   case "$v" in invite|open) echo SET ;; *) echo UNSET ;; esac ;;
      list)   [ -n "$(printf %s "$v" | tr -d "[:space:]")" ] && echo SET || echo UNSET ;;
      stripe) case "$v" in "") echo UNSET ;; sk_live_*|rk_live_*) echo LIVE ;; sk_test_*|rk_test_*) echo TEST ;; *) echo SET ;; esac ;;
    esac' sh "$2" "$3"
}
cls_envfile() {
  $SUDO awk -F= -v k="$1" -v rule="$2" '
    $1 == k { v = substr($0, length(k) + 2); gsub(/^["\047]|["\047]$/, "", v); found = v }
    END {
      if (rule == "flag")   print (found == "1") ? "SET" : "UNSET";
      else if (rule == "mode")   print (found == "invite" || found == "open") ? "SET" : "UNSET";
      else if (rule == "list")   { g = found; gsub(/[[:space:]]/, "", g); print (g != "") ? "SET" : "UNSET" }
      else if (rule == "stripe") { if (found == "") print "UNSET"; else if (found ~ /^(sk|rk)_live_/) print "LIVE"; else if (found ~ /^(sk|rk)_test_/) print "TEST"; else print "SET" }
    }' "$ENV_FILE"
}
row() { printf '%-34s %-28s %-8s %-8s expected %s\n' "$1" "$2" "$3" "$4" "$5"; }
printf '%-34s %-28s %-8s %-8s %s\n' CONTROL VARIABLE RUNNING ENV_FILE ""
row "public business signup"   "SIGN_PUBLIC_SIGNUP_ENABLED" "$(cls_container "$PA_C" SIGN_PUBLIC_SIGNUP_ENABLED flag)" "$(cls_envfile SIGN_PUBLIC_SIGNUP_ENABLED flag)" UNSET
row "Personal (platform-admin)" "SIGN_PERSONAL_SIGNUP_MODE"  "$(cls_container "$PA_C" SIGN_PERSONAL_SIGNUP_MODE mode)" "$(cls_envfile SIGN_PERSONAL_SIGNUP_MODE mode)" UNSET
row "Personal (sign)"          "SIGN_PERSONAL_SIGNUP_MODE"  "$(cls_container "$SIGN_C" SIGN_PERSONAL_SIGNUP_MODE mode)" "$(cls_envfile SIGN_PERSONAL_SIGNUP_MODE mode)" UNSET
row "Stripe key (sign)"        "STRIPE_SECRET_KEY"          "$(cls_container "$SIGN_C" STRIPE_SECRET_KEY stripe)" "$(cls_envfile STRIPE_SECRET_KEY stripe)" "TEST or UNSET"
row "Stripe key (platform-admin)" "STRIPE_SECRET_KEY"       "$(cls_container "$PA_C" STRIPE_SECRET_KEY stripe)" "-" UNSET
row "checkout prices"          "STRIPE_PLAN_PRICES"         "$(cls_container "$SIGN_C" STRIPE_PLAN_PRICES list)" "$(cls_envfile STRIPE_PLAN_PRICES list)" UNSET
row "Stripe command worker"    "SIGN_BILLING_COMMANDS_ENABLED" "$(cls_container "$SIGN_C" SIGN_BILLING_COMMANDS_ENABLED flag)" "$(cls_envfile SIGN_BILLING_COMMANDS_ENABLED flag)" UNSET
SH
bash /tmp/ccp-dark-state-check.sh
rm /tmp/ccp-dark-state-check.sh
```

Any row whose RUNNING or ENV_FILE class differs from "expected" is a **HALT**: the dark state is not proven, and no
activation may proceed. Report the row; do not change the switch from this runbook.

## 4. Data check (read-only; after the CCP migrations)

```bash
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN TRANSACTION READ ONLY;
-- checkout: no provider price pinned to any plan version (with STRIPE_PLAN_PRICES empty, checkout is refused)
SELECT count(*) AS pinned_provider_prices FROM subscription."PlanVersionPrice";
-- Astre MANUAL intact: exactly one open row, MANUAL, ACTIVE, the included plan, no provider link
SELECT t.slug, ts.source, ts.status, p.key AS plan_key, ts.period_anchor,
       (ts.billing_subscription_ref IS NOT NULL) AS provider_linked, ts.product_key, v.version_number AS pinned_version
  FROM subscription."TenantSubscription" ts
  JOIN identity."Tenant" t ON t.id = ts.tenant_id
  JOIN subscription."Plan" p ON p.id = ts.plan_id
  LEFT JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id
 WHERE t.slug = 'astre' AND ts.ended_at IS NULL;
-- no self-service row, held activation or checkout in flight anywhere
SELECT (SELECT count(*) FROM subscription."TenantSubscription" WHERE ended_at IS NULL AND source = 'SELF_SERVICE') AS open_self_service,
       (SELECT count(*) FROM subscription."BillingReconciliationFlag" WHERE resolved_at IS NULL) AS open_flags,
       (SELECT count(*) FROM subscription."CheckoutIntent" WHERE status = 'CREATED') AS open_checkout_intents;
ROLLBACK;
SQL
```

Expect `pinned_provider_prices = 0`; exactly one Astre row (MANUAL, ACTIVE, `aramo-sign-included-v1`,
`provider_linked = f`, `product_key sign`, pinned version 1); `open_self_service = 0`, `open_flags = 0`,
`open_checkout_intents = 0`. Before the CCP migrations (no `PlanVersionPrice`, `product_key` or `plan_version_id`),
use `RUNBOOK-ccp-migration-validation.md` §3 P6 for Astre and skip the pin count.

Also run the A11 fact-check (`RUNBOOK-ccp-migration-validation.md` §3 P3) and record its section (3): Astre's
open MANUAL row, `billing_link=absent`.

## 5. Record

Paste the full §3 and §4 output, the date and time, the box HEAD and the PO authorization reference into the release
evidence folder (`OneDrive/Aramo/documents/…`). This record is the C-27 evidence for that activation only.
