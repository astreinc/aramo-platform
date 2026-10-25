# CCP-A11 — acceptance evidence (Astre backfill tooling, dry-run only)

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.1 A11 row.

| | |
|---|---|
| **Slice** | CCP-A11 (PBD §5.1 row A11) |
| **Pre-execution** | `doc/ccp/slices/CCP-A11-pre-execution.md` (the needs table §3, choices C-1…C-7) |
| **Baseline** | `wip/ccp-a11` at `1754d857` |
| **Commit SHAs** | pending (lead commits) |
| **Production** | **Not read, not connected, not executed.** Neither command was run against any database other than a local testcontainer. |
| **HALT** | **None.** No effective-service difference (§3). No production read. No schema change was needed (no `20261026100000_ccp_a11_*` migration). |

## 1. The answer: what CCP needs to represent Astre's existing state

| Need | Delivered by | A11 action | Writes if executed |
|---|---|---|---|
| `product_key` / `composition_role` | A4 migration backfill (`sign` / `BASE`) | verified per open row (`PRODUCT_DIMENSION_INVALID` = HALT) | 0 |
| Version pin | A5 migration (`plan_version_id` = the plan's PUBLISHED v1, byte-equal to the live rows) | verified: checksum integrity (`PIN_CHECKSUM_MISMATCH` = HALT), v1 = live rows and = the A5 seed checksum (REVIEW when not) | 0 |
| Entitlement provenance | A7 migration (`granted_source = MIGRATION` + ledger `GRANTED`) | verified and reported; never re-sourced (DR-A11-2) | 0 |
| Commercial audit trail | none for a pre-CCP row | **the gap** | 1 `CommercialAuditEvent` per row |
| Governed record of the pre-CCP manual grant | none (`MIGRATION`-kind requests are refused at create, TD-A3-14) | `COMMERCIAL_PRE_CCP_GRANT_RECORDED`, subject `subscription:<id>`, system actor, no change request; payload: product, role, source, status, plan, pinned version id/number/checksum, anchor, start, billing link (boolean), capabilities with provenance, a state checksum, the ACTIVE policy version. No e-mail, name or provider reference | same row |

For production (projected from the known facts, not measured): **1** planned record (Astre's MANUAL row), **0** writes to any other table, and no C-16(a) HALT (0 `CheckoutIntent` rows).

## 2. Dry-run counts (the production-like fixture)

**Fixture** (`libs/subscription/src/tests/fixtures/ccp-a11-production-like.ts`), seeded on the **pre-CCP** schema and then carried through every CCP migration (entitlement A7; subscription A2…A7), exactly as a release would:
- **ASTRE**: the production facts. 1 open subscription, MANUAL, ACTIVE, `aramo-sign-included-v1`, started 2026-10-19, no Stripe link. Entitlements `core, ats, portal, sign`. 42 consumed, 2 released and 1 fresh reservation in the current period; storage 1 MiB active.
- **STRIPE**: a Stripe-linked SELF_SERVICE row (`aramo-sign-standard-business-v1`) plus the ended MANUAL row it replaced.
- **REVOKED**: a pre-CCP MANUAL row whose `sign` is revoked after the migrations, through the governed `ENTITLEMENT_REVOKE`.
- **ATS_ONLY**: `core, ats`, no subscription.
- **GOVERNED**: opened after the migrations through a governed `SUBSCRIPTION_OPEN`.

The exact report (A11-DRY-1), pinned byte for byte in `libs/subscription/src/tests/fixtures/ccp-a11-dry-run.golden.txt`:

| Count | Value |
|---|---|
| subscriptions_total / subscriptions_open | 5 / 4 |
| open_manual | 3 |
| open_manual_governed_by_change_request | 1 (GOVERNED) |
| open_manual_already_recorded / _withdrawn | 0 / 0 |
| **open_manual_to_record** | **2** (ASTRE, REVOKED) |
| open_self_service_not_in_scope / open_free_not_in_scope / open_development | 1 / 0 / 0 |
| open_pinned_checksum_ok / open_pinned_v1 / open_product_sign_base | 4 / 4 / 4 |
| entitlement_rows / active / revoked | 15 / 14 / 1 (includes the 3 rows the entitlement init migration seeds for the bootstrap tenant) |
| entitlement rows by source | MIGRATION active 12, revoked 1; PLAN active 2 |
| checkout_intents / created_for_manual | 0 / 0 |
| pre_ccp_records_existing | 0 |
| **planned writes** | `subscription."CommercialAuditEvent"` **2**; `TenantSubscription`, `CommercialChangeRequest`, `SubscriptionVersionPinEvent`, `AllowanceUsage`, `CapacityUsage`, `entitlement."TenantEntitlement"`, `entitlement."TenantEntitlementEvent"`: **0** each |
| exceptions | 1: HALT 0, REVIEW 1 |

**Exception report:** `REVIEW PRODUCT_CAPABILITY_REVOKED` (REVOKED: "sign is revoked; the backfill never re-grants (resurrection guard)").

Planned records: ASTRE `dacd7cb7-e557-72b6-8ac7-814fe3c48906` (capabilities `ats:MIGRATION, core:MIGRATION, portal:MIGRATION, sign:MIGRATION`, v1 checksum `6ec16b4a…62bf8` = the A5 seed checksum); REVOKED `200c4778-0952-7677-8304-ea6753495cc9` (`core:MIGRATION, sign:MIGRATION:revoked`).

On the pre-CCP schema the dry run refuses and lists the 9 missing CCP columns (A11-DRY-0).

**Exception codes** (HALT stops any execution; REVIEW is reported): HALT: `NO_ACTIVE_COMMERCIAL_POLICY`, `OPEN_CHECKOUT_INTENT_FOR_MANUAL` (Conv. C-16(a)/C-17), `PIN_CHECKSUM_MISMATCH`, `PRODUCT_DIMENSION_INVALID`, `MANUAL_ROW_BILLING_LINKED`. REVIEW: `DEVELOPMENT_ROW_OPEN`, `MANUAL_ROW_NOT_SENDING`, `PRODUCT_CAPABILITY_MISSING`, `PRODUCT_CAPABILITY_REVOKED`, `PIN_NOT_LIVE_V1`, `PIN_V1_DIFFERS_FROM_SEED`, `RECORD_WITHDRAWN`.

## 3. No-service-change proof

| Test | What is compared | Result |
|---|---|---|
| **A11-DRY-1** | The dry run's statements (recorded): first `BEGIN TRANSACTION READ ONLY`, last `ROLLBACK`, 0 write statements. The whole-database fingerprint (count + md5 of every row of every base table in `identity`, `entitlement`, `metering`, `subscription`) before and after | equal ✅ |
| **A11-NSC-1** | Effective service as one JSON text, before and after **applying** the 2 planned records (test-only apply): for each of the 5 tenants, `AllowanceService.getStatus` and `staleReservations` (`sign.envelopes`), `CapacityService.status` (`sign.storage_bytes`), `SubscriptionLifecycleService.account`, the A7 readers `EntitlementRepository.getCapabilities` and `listTenantIdsWithCapability` (all 6 capabilities), and `EntitlementGuard` with `@RequireCapability` for each of the 6 capabilities. That is 5 × 11 + 6 = **61 observations** | **byte-identical** ✅ (ASTRE: `limit 100, used 43, remaining 57`; capabilities `ats, core, portal, sign`; REVOKED `sign` → 403 `TENANT_CAPABILITY_NOT_ENTITLED`, before and after) |
| A11-NSC-1 (usage) | Every `AllowanceUsage` and `CapacityUsage` row as JSON | unchanged ✅ |
| A11-NSC-1 (database) | Fingerprint diff | exactly 1 table changed, `subscription.CommercialAuditEvent`, by exactly **+2** rows (system actor, no change request, deterministic ids and correlation ids) ✅ |
| **A11-IDEM-1** | Re-run after the apply: the dry run plans 0 (2 already recorded); a second apply inserts 0; fingerprint = after the first apply; effective service = before the backfill; the report repeats byte for byte | ✅ |
| **A11-COMP-1** | The compensating SQL (§6): +2 withdrawal events, a second run +0; effective service = before the backfill; only `CommercialAuditEvent` differs from before the backfill; the dry run then reports `RECORD_WITHDRAWN` ×2 and plans 0; a DELETE of a record is still rejected | ✅ |
| **A11-HALT-1** | A CREATED checkout intent for ASTRE: dry run HALT (`OPEN_CHECKOUT_INTENT_FOR_MANUAL`), apply refused, fingerprint unchanged | ✅ |

Structural reason: the only table a backfill writes is `CommercialAuditEvent`, and none of the effective-service readers above reads it (searched: 0 references in `allowance.service.ts`, `capacity.service.ts`, `billing/subscription-lifecycle.service.ts`, `libs/entitlement/src/lib/`).

## 4. The read-only fact-check

`npm run ccp:astre-fact-check -- [--database-url <url>] [--po-authorization-ref <ref>]` (`libs/subscription/prisma/ccp-astre-fact-check.ts` → `src/lib/commercial/ccp-fact-check.ts`). One `BEGIN TRANSACTION READ ONLY` session, always `ROLLBACK`. It prints: schema stage (pre-CCP / partial / CCP-A7); open subscriptions by product, source and status; subscriptions by source (open / total); each tenant with an open MANUAL row (tenant id, open-row count, plan key, status, start and anchor dates, billing link present/absent, plan version, entitlements with provenance); checkout intents by status; entitlement rows by capability and source; identity roles / scopes / role-scopes; plans and plan versions by status; pre-CCP record count; change requests by kind. Missing CCP columns print "n/a".

| Test | Result |
|---|---|
| A11-FACT-1 (pre-CCP schema, production today) | stage `pre-CCP`; ASTRE: 1 open subscription, `aramo-sign-included-v1`, ACTIVE, started 2026-10-19, billing link absent, entitlements `ats, core, portal, sign`; 0 checkout intents; no e-mail-shaped string in the output ✅ |
| A11-FACT-2 (post-CCP) | first statement `BEGIN TRANSACTION READ ONLY`, last `ROLLBACK`, 0 write statements, fingerprint unchanged; stage `CCP-A7`; ASTRE `v1 PUBLISHED`, `…:MIGRATION`; REVOKED `sign:MIGRATION:revoked`; no PII ✅ |
| A11-CLI-1 | both commands against the testcontainer print exactly the library report (backfill exit 0); both exit 2 on a non-local URL ✅ |

**Not run against production.** A non-local URL is refused unless `--po-authorization-ref` names the separate PO authorization (row A11 HALT).

## 5. Refusal guards

| Test | Refusal | Result |
|---|---|---|
| A11-G-1 | no `--dry-run` → `DRY_RUN_REQUIRED` | ✅ |
| A11-G-2 | `--execute` (with or without `--dry-run`) → `EXECUTE_NOT_AUTHORIZED`; any unknown flag → `UNKNOWN_ARGUMENT` | ✅ |
| A11-G-3 | 10 non-local URLs refused `DATABASE_URL_NOT_LOCAL` (remote hosts, the production IP, a `localhost.`-prefixed domain, `host` / `hostaddr` / `service` overrides, a socket path, a non-postgres scheme, garbage); 4 loopback forms admitted; no URL → `DATABASE_URL_MISSING` | ✅ |
| A11-G-4 | fact-check: local runs; non-local without (or with a blank) `--po-authorization-ref` → refused | ✅ |
| A11-G-5 | record ids deterministic | ✅ |
| A11-G-6 | the real commands (through `deploy/jiti-tsconfig-runner.mjs`) exit **2** on each of the 4 refusals, before connecting | ✅ |

## 6. Compensating migration (documented; for when the backfill is ever executed)

The backfill adds no schema, so no schema compensation exists. Its only writes are append-only audit rows; the stream rejects UPDATE and DELETE, so compensation **appends** a withdrawal per record and deletes nothing. Shipped as the test fixture `libs/subscription/src/tests/fixtures/ccp-a11-compensating.sql` (executed by A11-COMP-1 only). Running it against production needs separate PO authorization, like the backfill (PBD §7.5, A0-C15).

```sql
DO $$
BEGIN
  IF (SELECT count(*) FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE') <> 1 THEN
    RAISE EXCEPTION 'CCP-A11 compensation refused: there is not exactly one ACTIVE commercial policy version';
  END IF;
  IF EXISTS (SELECT 1 FROM subscription."CommercialAuditEvent" e
              WHERE e.event_type = 'COMMERCIAL_PRE_CCP_GRANT_RECORDED'
                AND (e.change_request_id IS NOT NULL OR e.actor_type <> 'system' OR e.correlation_id NOT LIKE 'ccp-a11-backfill:%')) THEN
    RAISE EXCEPTION 'CCP-A11 compensation refused: a pre-CCP record not written by the CCP-A11 backfill exists';
  END IF;
END $$;

INSERT INTO subscription."CommercialAuditEvent"
  (id, actor_id, actor_type, actor_role_keys, event_type, is_exception, tenant_id, subject, change_request_id, policy_version_id, payload, correlation_id)
SELECT md5('ccp-a11:withdraw:' || e.id::text)::uuid, NULL, 'system', '{}', 'COMMERCIAL_PRE_CCP_GRANT_RECORD_WITHDRAWN', false, e.tenant_id, e.subject, NULL,
       (SELECT p.id FROM subscription."CommercialPolicyVersion" p WHERE p.status = 'ACTIVE'),
       jsonb_build_object('backfill', 'CCP-A11', 'record_kind', 'PRE_CCP_MANUAL_GRANT', 'withdraws_event_id', e.id::text),
       'ccp-a11-compensation:' || e.id::text
  FROM subscription."CommercialAuditEvent" e
 WHERE e.event_type = 'COMMERCIAL_PRE_CCP_GRANT_RECORDED'
 ORDER BY e.id
ON CONFLICT (id) DO NOTHING;
```

After compensation the dry run reports each withdrawn row as `RECORD_WITHDRAWN` (REVIEW) and plans nothing: re-recording needs a new authorization. **Code rollback:** delete the two commands, the two library files and the A11 test files; nothing else depends on them.

## 7. Tests run and not run

| Run | Result |
|---|---|
| `ARAMO_RUN_INTEGRATION=1` `libs/subscription` `ccp-a11-astre-backfill.integration.spec.ts` + `ccp-a7-entitlement-revoke.integration.spec.ts` (regression for the shared-helper export) | 2 files, 20 passed (A11 9, A7 11) |
| `libs/subscription` unit (`vitest run`, integration files skipped without the flag), incl. `ccp-a11-backfill-guards.spec.ts` (6) | 9 files, 208 passed; 15 files / 242 tests skipped |
| `nx run subscription:build --skip-nx-cache` | ok |
| `nx run subscription:lint` | 0 errors, 62 warnings (3 of them `no-non-null-assertion` in the A11 spec; the rest pre-existing) |
| `bash scripts/verify-vocabulary.sh` | exit 0: Tier 1, Tier 2, front-door clean; no exemption touched |
| `tests:integration:check` | ok: 49 bearing projects covered by 49 roots (the A11 spec is under the existing `libs/subscription` root) |
| `env:passthrough-check` | ok (no new env var; the commands read the existing `DATABASE_URL`) |
| `repo-map:generate` / `repo-map:check` | regenerated (`doc/generated/repo-map.{files,coupling,projects}.json`); ok, under a temporary `GIT_INDEX_FILE` with intent-to-add entries for the new paths (real index untouched) |

**Not run:** the full `nx run api` (instructed; required before the program push, PBD §8); Pact (no route, DTO or returned shape changed, no migration, so nothing to register in `pact/provider/src/verify-api.ts`); `contract-parity` / `openapi:drift-check` / `orphan-scopes:check` / `error-codes:check` (no route, scope, OpenAPI or error code touched). **Not run against production:** both commands (row A11 Out / HALT).

## 8. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| TD-A11-1 | Citation | The cited standing rule "Preserve Astre's existing MANUAL subscription and entitlements without modification" is not in `doc/ccp/decisions.md` at `1754d857`. Applied from Charter §1.5, Conv. `:234`, MP-A2 §4 and PBD §12 | Lead to add the row to the register if intended |
| TD-A11-2 / **DR-A11-1** | Design choice (decision request) | `commercial-change-request.service.ts:271` says "MIGRATION by the CCP-A11 backfill". A11 creates **no** `MIGRATION`-kind change request: an `APPLIED` request needs approvals and a `CommercialChangeApplication` that never happened, which would invent history (MP-A2 §4 preserved provisions). The audit event is the record. Whether a future execution must also open a governed `MIGRATION` request (and its approval chain and apply semantics) is a **PO / Architect decision** | For ruling before any execution |
| TD-A11-3 / **DR-A11-2** | Decision request | Astre's entitlements stay `granted_source = MIGRATION` (truthful: pre-CCP provenance unknown). Re-sourcing `sign` to `MANUAL` needs a change request (`TenantEntitlement_commercial_source_check`) and modifies Astre's entitlements, which the preservation rule forbids | Recorded; PO / Architect if a commercial source is wanted |
| TD-A11-4 | Scope | `applyPreCcpBackfill` exists in library code so the fixture tests can prove the writes are service-neutral and idempotent. No command calls it; the CLI refuses `--execute` unconditionally. It requires a `po_authorization_ref` and refuses on any HALT | Recorded |
| TD-A11-5 | Fixture | The entitlement init migration seeds 3 rows for the bootstrap tenant; the counts include them (15 rows, not 12) | Recorded |
| TD-A11-6 | Reader coverage | `TenantEntitlementReader` (libs/identity) is not called: it is a pass-through to `EntitlementRepository.getCapabilities` (`libs/identity/src/lib/tenant-entitlement-reader.service.ts:15-16`), and calling it from `libs/subscription` tests would add an nx edge. A7-AUTH-1 already covers it | Recorded |
| TD-A11-7 | Shared helper | `seedCcpCatalog` in `libs/subscription/src/tests/support/ccp-a3-database.ts:85` is now exported (no behaviour change) | Merge note |
| TD-A11-8 | Output content | The fact-check prints tenant UUIDs and, when given, the PO authorization reference. It never prints names, e-mails, `created_by`, or provider references (the fixture plants e-mail-shaped `created_by` values and Stripe refs; the tests assert none appears) | Recorded |
| TD-A11-9 | Exception severity | The HALT / REVIEW split (§2) is an executor choice: HALT for anything that conflicts with the Conversion Rule or the integrity of the pin / product dimension; REVIEW for states the backfill must report but never change | For Lead review |
| TD-A11-10 | Merge hotspots | `package.json` scripts, `doc/generated/repo-map.*`, `support/ccp-a3-database.ts`. If A8 counts `CommercialAuditEvent` rows by type for its windows, the two new event types are distinct | Lead merges; regenerate the repo map after the merge |

## 9. Commit map (lead commits; SHAs pending)

| # | Commit | Files |
|---|---|---|
| A11-1 | `CCP-A11: pre-execution record` | `doc/ccp/slices/CCP-A11-pre-execution.md` |
| A11-2 | `CCP-A11: dry-run Astre backfill planner and read-only fact-check (no execute path)` | `libs/subscription/src/lib/commercial/pre-ccp-backfill.ts`, `libs/subscription/src/lib/commercial/ccp-fact-check.ts`, `libs/subscription/prisma/ccp-astre-backfill.ts`, `libs/subscription/prisma/ccp-astre-fact-check.ts`, `package.json` (`ccp:astre-backfill`, `ccp:astre-fact-check`) |
| A11-3 | `CCP-A11: production-like fixture, compensating SQL and tests` | `libs/subscription/src/tests/fixtures/ccp-a11-production-like.ts`, `fixtures/ccp-a11-compensating.sql`, `fixtures/ccp-a11-dry-run.golden.txt`, `ccp-a11-astre-backfill.integration.spec.ts`, `ccp-a11-backfill-guards.spec.ts`, `support/ccp-a3-database.ts` (export) |
| A11-4 | `CCP-A11: acceptance evidence` + `CCP-A11: regenerate repo map` | `doc/ccp/slices/CCP-A11-acceptance.md`; `doc/generated/repo-map.{files,coupling,projects}.json` |

## 10. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0; Tier 1, Tier 2 and front-door clean. No exemption added or touched.
