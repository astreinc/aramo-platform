# CCP production rollout plan (CCP-D6)

> **Nothing in this plan has been executed.** It is the ordered plan PBD §5.4 row D6 asks for. **Every step
> requires separate PO authorization (PBD §12)**, recorded before the step runs. Approving this plan authorizes no step
> of it. Design approval is not production migration authority (ruling A0-C15, PBD §2.6, §7.5).

| | |
|---|---|
| **Program branch** | `feat/ccp-commercial-control-plane`, head `1d25faad` when written. C8-PR (`wip/ccp-c8pr`) and UI-V12 (`wip/ccp-v12`) are still to merge. |
| **Production** | `52ea8de6`. No CCP migration, code or switch is in production. |
| **Box mechanics** | `doc/runbooks/RELEASE-box.md`. Compose is `-p aramo-singlebox -f docker-compose.prod.yml`. Box git and docker need `sudo`. Build ≠ recreate. `nginx -t` runs in its own ssh call. Terraform is never run from the box. |
| **Checklist** | `doc/ccp/program-completion-checklist.md` (evidence, required steps §3, missing evidence §4) |
| **Register** | `doc/ccp/delivered-not-delivered-register.md` |

## Separate track: PROD-SEC-1

**PROD-SEC-1 (backups, key rotation) is a separate track, outside CCP** (`doc/ccp/decisions.md:519`). Per the Architect, it should precede, or at least accompany, any production change, including steps 3–8 below.

This plan does not contain or schedule PROD-SEC-1 work. It only records that dependency. Two consequences apply:
- the migration backup (step 3 P1) does not cover the Talent Intelligence database (G-082; `RUNBOOK-ccp-migration-validation.md:99`);
- the key-custody follow-ups stay open.

## Gate sequence

PBD §11 sets the order:
1. per-slice execution;
2. local phase gates;
3. the **program acceptance review** (§11 step 4);
4. **one push and one PR** after explicit PO authorization (§11 step 5);
5. CI and the final Gate-6 review (§11 step 6).

Only then may merge, production migration, deploy and each activation be authorized, each on its own. Steps 1–8 below start at §11 step 5. **Before step 1:** the program acceptance review is complete; C8-PR and UI-V12 are merged and re-verified on the integrated branch (`doc/ccp/decisions.md:77`); and the final integrated gate is recorded (checklist §3.5, ⟪FINAL: final integrated gate head SHA and its exact counts⟫).

---

## Step 1: Push, the single PR and CI (including the full `nx run api`)

**Requires separate PO authorization (§12; PBD §3.4, §11 step 5).**

| | |
|---|---|
| **Preconditions** | Program acceptance review complete (PBD §11 step 4). The branch is synced forward with `origin/main` (PBD §3.5; R-SYNC). The final integrated gate is recorded at the exact head being pushed. The vocabulary script and `repo-map:check` pass. |
| **Command reference** | One push of `feat/ccp-commercial-control-plane`; one PR to `main` (PBD §3.4). The full `ARAMO_RUN_INTEGRATION=1 nx run api` runs in CI. This is the CI-only exception, in force per the PBD ratification note and `doc/ccp/program-gate-20261025.md:36`. |
| **Verification** | Observe the actual GitHub checks (PBD §8, §11 step 6), the full `nx run api` included. A CI integration failure is reproduced locally before any re-push (PBD §8). Pact: report the consumer count and the consumers verified by each provider separately (`doc/ccp/program-gate-20261025.md:101-111`). |
| **Rollback** | Close the PR. Nothing has reached `main` or production. |

## Step 2: Merge to `main`

**Requires separate PO authorization (§12; PBD §11 step 6: "request separate merge authorization").**

| | |
|---|---|
| **Preconditions** | CI green on the PR head, the full `nx run api` included. The final Gate-6 review is complete. No intermittent gate is called green (`doc/ccp/decisions.md:230`). |
| **Command reference** | The merge-queue procedure in memory note `feedback_auto_mode_blocks_unreviewed_merge`: `gh pr merge <N> --merge --auto`. Do not squash across slices (PBD §3.2). |
| **Verification** | The merge-group run is green (the gate of record, `RELEASE-box.md` STEP 0). Record the `main` merge SHA; it becomes the deploy `TARGET_SHA`. |
| **Rollback** | Revert the merge commit on `main` through a PR. Production is still untouched. |

## Step 3: Production migration (before any code)

**Requires separate PO authorization (§12; A0-C15).** Migrate before code: `deploy/migrate-prod.sh` runs after `git pull` and before the image build (`RUNBOOK-ccp-migration-validation.md:20-21`; `RELEASE-box.md` STEP 3).

| | |
|---|---|
| **Preconditions** | A recorded PO authorization for this migration run. The box HEAD equals the authorized `TARGET_SHA` (`RELEASE-box.md` STEP 1). PROD-SEC-1 is addressed or explicitly accepted (see above). |
| **Command reference** | `doc/runbooks/RUNBOOK-ccp-migration-validation.md`. |
| **Backup** | §3 P1: `pg_dump` to `/opt/aramo/pre-ccp-migration-backup-<ts>.sql`. Check the size and run `grep -c 'PostgreSQL database dump complete'` = 1. Do not use `tail -1` (D5-OBS-1). |
| **Exact pending set** | §3 P2. Expect only the CCP migrations, with `non_ccp=0` unless separately authorized. **HALT** if the ATI-SEP-1 drop `talent-record/20261024170000_ati_sep_1_drop_legacy_trust_schemas` is pending: it sorts between CCP-A1 and CCP-A2 and needs its own PO decision (§2; G-073). The 5 `main` migrations from R-SYNC each need their own authority or must already be applied (§2; `doc/ccp/decisions.md:462-474`). |
| **Fact-check** | §3 P3: `npm run ccp:astre-fact-check -- --po-authorization-ref "<ref>"`. It is read-only and refuses a non-local URL without a reference. |
| **Catalog pre-check** | §3 P4, TD-A1-1. Expect `a1_ids_or_keys_already_present = 0` and `tenant_read_scope = 1`. Also run §3 P5, C-16(a) = 0 rows, else HALT (C-17), and §3 P6, the Astre snapshot. |
| **Env pre-check** | §4: `grep -c '^INTELLIGENCE_DB_USER=' /opt/aramo/.env`. FIX1 changed `migrate-prod.sh` to resolve the TI env before any docker call (D5-DEF-1, `CCP-FIX1-acceptance.md:87-104`). Run the pre-check anyway. |
| **Stop point** | Apply bounded: `sudo bash deploy/migrate-prod.sh --until <last CCP migration>`. |
| **Migration counts at `1d25faad`** (from the runbook) | **CCP:** 27 migrations (`:19`); stop point `20261029000100_ccp_alert_type_union` (`:216`); gate `27 applied`, plus any separately authorized `main` migration (`:219`). **main:** the 5 R-SYNC migrations (`auth-storage/20261025120000_native_device_sessions`, `sign/20261026100000…100300_sign_mobile_*`), which production `52ea8de6` predates (`:66-72`). From scratch, the whole tree applied 331 / 331 at the program gate (`doc/ccp/program-gate-20261025.md:39`). |
| **After C8-PR** | C8-PR adds `identity/20261028070000_ccp_a1a2_payment_request_scope` and `subscription/20261030010000_ccp_c8pr_payment_record` (29 compensation steps, `wip/ccp-c8pr:…/CCP-C8PR-acceptance.md:76`). The runbook is not yet updated (G-C8PR-2): ⟪FINAL: CCP migration count, `--until` stop point, gate count and Q1 / Q7 / Q11 expected values after the C8-PR merge, from the updated runbook⟫. |
| **Verification** | §5 post-checks Q1–Q11 against the table at `RUNBOOK-ccp-migration-validation.md:272-284`: Q2 commercial role grants = 0; Q3 one ACTIVE v1, checksum `bdc36ef2…52f5`; Q9 every operational table at 0 except 1 audit seed row. Then repeat P5, P6 (Astre byte-for-byte) and P3. Record the evidence (§7). |
| **Rollback** | Restore from the P1 backup; the backup is the floor (§6). A compensating SQL step is used only with its own PO authorization, newest first, and is refused while dependent data exists (§6 table; proven 30 / 30 by `ccp-full-compensation-chain.integration.spec.ts`). Do not build or recreate after a failed apply. |

## Step 4: Deploy: rebuild and recreate the affected containers

**Requires separate PO authorization (§12).**

| | |
|---|---|
| **Preconditions** | Step 3 completed and post-checked at the same `TARGET_SHA`. The `.env` changes below are reviewed and individually authorized. |
| **Command reference** | `RELEASE-box.md` STEP 5, governed build with `--build-arg GIT_REVISION`, then STEP 6, recreate only the rebuilt services, never postgres or redis. Then STEP 7 (healthy) and STEP 8 (running code = `TARGET_SHA`). Use `--skip-nx-cache` and grep a HEAD marker in dist (memory `feedback_local_stack_nx_cache_stale_dist`). |
| **Affected services** | Determine them from `git diff --stat 52ea8de6..<TARGET_SHA>` at STEP 5. The program changes `apps/platform-admin`, `apps/platform-web` (baked into the nginx image), `apps/sign-service`, `apps/api`, and the libs `subscription`, `entitlement`, `identity`, `auth-core`, `auth`, `auth-storage`, `common` and `sign`. So the images that embed them may need a rebuild: platform-admin, nginx, sign-service, api, auth-service, and any worker built from the api image. Rebuild and recreate exactly the set the diff shows. |
| **Every new worker off by default** | Leave these UNSET (absent) in `/opt/aramo/.env`. Each is off unless set to exactly `1`. |
| | `SIGN_BILLING_COMMANDS_ENABLED`: the C1 command outbox and inbox (`.env.prod.example:368-379`); |
| | `CCP_ALERTS_ENABLED`: the D3 scanner (`CCP-D3-acceptance.md:60`, `:148`; TD-D3-6, "for the PO at release"); |
| | `CCP_USAGE_ROLLUP_ENABLED`: the D1 worker (`CCP-D1-acceptance.md:58`, `:101`); |
| | `CCP_REFUND_EXECUTION_ENABLED`: gate 1, deliberately **not wired** in compose (`commercial-billing-adjustment.ts:15-16`), so it stays unset. |
| **Env changes** | **Remove `STRIPE_AUTOMATIC_TAX`** from `/opt/aramo/.env` (TD-C5-1, `CCP-C5-acceptance.md:96`; `.env.prod.example:363-364`; `doc/ccp/decisions.md:342`, `:512`). Keep `STRIPE_PLAN_PRICES` empty (CCP hold, 2026-10-25). Pass no `STRIPE_SECRET_KEY` and no `STRIPE_PORTAL_CONFIGURATION` to platform-admin (C3 NOT DELIVERED; TD-C3-2). Confirm with `env:passthrough-check` that the compose file passes every new variable (`doc/ccp/decisions.md:118`). |
| **Verification** | STEP 7 / 8. Then `docker exec <container> printenv` per variable, printing classes only, never values: `CCP_ALERTS_ENABLED`, `CCP_USAGE_ROLLUP_ENABLED`, `SIGN_BILLING_COMMANDS_ENABLED` UNSET; `STRIPE_AUTOMATIC_TAX` absent. Then go straight to step 5. Prod-only traps: boot smoke, and compiled seed rather than jiti (memory `feedback_prod_only_deploy_traps_ci_blind`). |
| **Rollback** | `RELEASE-box.md` ROLLBACK: recreate from the `:rollback-<sha>` images. The migrations from step 3 stay. They are additive and dark (Q9: empty operational tables), and the previous code ignores them. Compensate only through step 3's rollback, with its own authorization. |

## Step 5: Dark-state re-verification

**Requires separate PO authorization (§12).** The check reads production configuration and data. It is mandatory before any activation (PBD §7.3, Conv. C-27). The ruling does not itself establish that the switches are off (C-28).

| | |
|---|---|
| **Preconditions** | Step 4 complete and healthy. |
| **Command reference** | `doc/runbooks/RUNBOOK-ccp-dark-state-verification.md` §3 configuration script, §4 data check (after the CCP migrations), §5 record. Also record the step 4 class check of `CCP_ALERTS_ENABLED`, `CCP_USAGE_ROLLUP_ENABLED` and `CCP_REFUND_EXECUTION_ENABLED`: the runbook script does not list them (checklist §3.2). |
| **Verification** | Every row matches "expected", RUNNING and ENV_FILE alike. `pinned_provider_prices = 0`. Exactly one Astre row: MANUAL, ACTIVE, `aramo-sign-included-v1`, `provider_linked = f`, `product_key sign`, version 1. `open_self_service = 0`, `open_flags = 0`, `open_checkout_intents = 0`. Any mismatch is a HALT. |
| **Rollback** | Read-only, so nothing to roll back. A mismatch HALTs every later step. Do not change a switch from this runbook. |

## Step 6: Operator bootstrap (A9)

**Requires separate PO authorization (§12; T2-F1-H3 Amendment A1, A1-2(7): a production write).**

| | |
|---|---|
| **Preconditions** | Step 5 recorded for this activation. The CCP migrations are post-checked, with an ACTIVE policy (Q3). `doc/runbooks/RUNBOOK-ccp-platform-owner-bootstrap.md` is refreshed through a reviewed change first. Its §1 and §4 still HALT on D5-DEF-3, which FIX1 fixed and proved through the real runner (FIX1-RUN-1 / -2, `CCP-FIX1-acceptance.md:24-34`), and §3 item 2 still says "21 CCP migrations" (checklist §4 item 6). The §3 read-only checks match: `super_admin_holders = 1`, `platform_owner_holders = 0`, `bootstrap_events = 0`, `active_policies = 1`, 5 last-owner triggers `A`. |
| **Command reference** | Runbook §4: `npm run -s ccp:bootstrap-platform-owner -- --po-authorization-ref "<ref>" --human-ref-hash <64 hex>`, in the box node container. The command takes no target argument. |
| **Verification** | Runbook §6: `platform_owner_holders = 1`, `bootstrap_events = 1`, `bootstrap_attestations = 1`, the audit row `COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED`. Further owners come only through a governed ROLE_GRANT, approved by a distinct platform_owner (Q2). |
| **Rollback** | The command is permanently inert after its first grant (A1-2). A wrong grant is undone only through a governed ROLE_REVOKE, or under `RUNBOOK-ccp-break-glass.md` Part B with explicit PO authorization. The last-owner invariant (A1-4) must hold. |

## Step 7: Astre backfill (A11)

**Each part requires its own separate PO authorization (§12).** PBD §5.1 A11: "not executed in prod".

| | |
|---|---|
| **7a. Dry run: preconditions** | Steps 3–5 done. A restored copy of the step 3 P1 backup on a **non-production** host. |
| **7a. Command reference** | `RUNBOOK-ccp-migration-validation.md:290-292`: `npm run ccp:astre-backfill -- --dry-run`. It is local only: it refuses every non-local URL (`DATABASE_URL_NOT_LOCAL`) and `--execute` (`EXECUTE_NOT_AUTHORIZED`). |
| **7a. Verification** | Counts and the exception report, compared with the golden shape (`CCP-A11-acceptance.md:35-51`). The no-service-change proof holds: effective service byte-identical, usage unchanged (`:63-71`). Any HALT exception stops the backfill. |
| **7b. Execution: preconditions** | The PO / Architect rulings on **DR-A11-1** (whether a governed MIGRATION-kind change request must accompany execution) and **DR-A11-2** (whether Astre's `sign` entitlement is re-sourced from MIGRATION) (`CCP-A11-acceptance.md:149-150`). |
| **7b. Gap (record)** | No execute path exists: `applyPreCcpBackfill` has no command caller, and `--execute` is refused unconditionally (TD-A11-4, `:151`). Execution therefore also needs a reviewed code change, which is outside the frozen scope until a PO decision (`doc/ccp/decisions.md:492-495`). |
| **Rollback** | 7a writes nothing (read-only transaction, rolled back). 7b, if ever built: `libs/subscription/src/tests/fixtures/ccp-a11-compensating.sql` with its own authorization (`doc/ccp/program-gate-20261025.md:151`). |

## Step 8: Commercial activation, each capability gated on its external dependency

**Every line requires its own separate PO release authorization (§12), and a fresh step 5 dark-state record for that activation (C-27).** Live Stripe billing and public signup stay disabled while the §7.3 hold applies (PBD §12).

| Capability | Switch / act | External dependency (owner) | Preconditions specific to it | Rollback |
|---|---|---|---|---|
| Governed MANUAL operations (A6, A7, A8, B1–B6, B4 contracts, C8-PR payment record) | none: inert until step 6 (`CCP_NOT_BOOTSTRAPPED`) | none beyond PO authorization | step 6 done; operators attested (D9); UAT sign-off recorded (checklist §4 item 5); C8-PR: payment recording in production needs its own authorization (PAYMENT_RECORD A2 §6) | the governed reverse request; policy rollback via POLICY_ACTIVATE (`RUNBOOK-ccp-recovery.md` §9) |
| Apply deadline (Charter A1) | POLICY_ACTIVATE of a v2 with `apply_expiry_hours` (FIX1 draft key) | PO (D5 confirmed, `doc/ccp/decisions.md:55`) | step 6; Finance → Owner chain | activate the prior version |
| Alerts (D3) | `CCP_ALERTS_ENABLED=1` | PO (TD-D3-6) | env thresholds confirmed (TD-D3-2, `doc/ccp/decisions.md:147`) | unset it |
| Usage roll-ups (D1) | `CCP_USAGE_ROLLUP_ENABLED=1` | PO | `npm run usage:rollup -- --reconcile-only` clean first (`RUNBOOK-ccp-recovery.md` §7) | unset it; roll-ups are derived |
| Stripe command worker (C1, C2 conversions) | `SIGN_BILLING_COMMANDS_ENABLED=1` | PO (§7.3, C-26) | the A6 guard and C1 / C2 path delivered, validated and release-authorized (§7.3); the dispatcher refuses a live key (TD-C1-3); DR-C2-1 keeps committed self-service rows refused (Finance / PO) | unset it; commands are retryable, never dropped |
| Live Stripe billing + public signup | live `STRIPE_SECRET_KEY`, `STRIPE_PLAN_PRICES`, `SIGN_PUBLIC_SIGNUP_ENABLED` | **Stripe** live account and keys; **PO** release (§7.3, CCP hold 2026-10-25) | the TD-C1-3 / TD-C3-3 live holds lifted by a reviewed change | revert the env; `RUNBOOK-ccp-recovery.md` |
| Billing status read (C3) | platform-admin `STRIPE_SECRET_KEY` + `STRIPE_PORTAL_CONFIGURATION` | **Stripe** portal configuration verified (D18); restricted read-only credential with security evidence (**Security / PO**, TD-C3-2) | C3 stays NOT DELIVERED until both are verified (`doc/ccp/decisions.md:139`, `:190`) | unset both |
| Credits, discounts (C4) | the C1 worker + live keys | **Legal**: refund / credit policy (PBD §10); **Finance**: approved credit policy (TD-C4-18) | live Stripe line above | compensating command by a new change request |
| Refunds (C4, C4-P, DG) | gate 2: POLICY_ACTIVATE of a version with the three RX keys; gate 1: `CCP_REFUND_EXECUTION_ENABLED=1`, which needs a compose change | **Finance, Legal counsel, Platform Owner**: refund policy approved and LOCKED (RX-3); **PO**: D5 key confirmation (`doc/ccp/decisions.md:292`) | **RX-4 hash check (checklist §3.1)**; Charter A2 §8 rows 2–8 in order | activate a version without the keys (RX-9); unset gate 1 |
| Tax (C5) | none exists: tax is disabled in code | **Tax**: Stripe Tax registration | a future release with its own authorization (`.env.prod.example:363-364`) | n/a |
| Self-service cancel / upgrade (C7) | the approved terms document version | **Legal / counsel**: APPROVED terms; upgrade DR-C7-1 (**PO / Architect**) | — | n/a |
| Enterprise invoicing | `invoicing.enabled` stays `false` | **Finance / PO** operating model; ACCT is a separate program (`doc/ccp/decisions.md:274`) | out of CCP | n/a |
| Non-Sign product catalog (ATS, Intelligence, Portal) | catalog rows | **PO / Finance**: approved pricing (PBD §7.1, §10) | a new commercial decision | n/a |

## ⟪FINAL⟫ placeholders in this file

- ⟪FINAL: final integrated gate head SHA and its exact counts⟫ (Gate sequence)
- ⟪FINAL: CCP migration count, `--until` stop point, gate count and Q1 / Q7 / Q11 expected values after the C8-PR merge, from the updated runbook⟫ (Step 3)
