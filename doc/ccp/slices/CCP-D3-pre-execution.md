# CCP-D3 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §2.3 and §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-D3: observability (billing and approval metrics, alerts, exception management) |
| **Schedule row** | PBD §5.4, row D3 (binding), `:123` |
| **Branch / baseline** | `wip/ccp-d3` at `6b5051a8` ("CCP-C1: Stripe command outbox + webhook inbox …"). Working tree clean at start. |
| **Drift since the previous slice** | None on this branch: C1 is the head commit. CCP-D1 (`73c33238`, usage roll-ups) is committed on another line (`wip/ccp-d1`, merged into the program branch at `18b2c032`) and is **not** an ancestor of `6b5051a8`. D3's D1 alert source is therefore written against D1's committed schema without importing D1 code (D3-C4). Other slices run in parallel worktrees; overlaps are merge items for the lead (§6). |

## 1. Governing instruments (SHA-256 re-verified against the `.sha256` sidecars: MATCH)

| Instrument | SHA-256 |
|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` |
| `Aramo-PLATFORM-UX-1-Platform-Admin-and-Template-Studio-Directive-v1_0-LOCKED.md` | `e94fa124341ecaa125dcd170066999549f1c8599756437f4294db4ae1361ac2c` |
| `Aramo-PLATFORM-UX-1-…-Amendment-A1-CCP-Scope-v1_0-LOCKED.md` | `9c84fbc9e5af5bbf790553723f1080739b2318c30fa9431a9bdbc9f377c7a50c` |
| `Aramo-CCP-Program-Charter-v1_0-LOCKED.md` | `82d328eb11b586eb0df5d183d9c88c6899053c9257be7b5245f77e212c54b788` |

Clauses relied on (verbatim, `path:line` in OneDrive `Aramo/locked`):
- PBD `:123` (§5.4 row D3): "**In:** billing and approval metrics, alerts, exception management. **Out:** health or rating metrics (PLATFORM-UX-1 `:139`) | Alerts fire on injected failures | Revert | — | Alert test outputs".
- PLATFORM-UX-1 `:139`: "- Any health or rating metric."
- PLATFORM-UX-1 `:78` R-19: "The dashboard shows counts, ages, statuses and events only."
- PLATFORM-UX-1 A1 `:47` A1-2: "A CCP UI slice SHALL NOT change a plan, subscription, capability or billing state directly from the console."
- PLATFORM-UX-1 A1 `:68` A1-4a: "the operator dashboard SHALL show **counts, states and operational events only**."
- PBD `:31` §2.5: UI parts of D need their pinned Claude Design handoff.

## 2. Prerequisites (PBD D3 row: "A3, A6, C1 evidence")

| Prerequisite | Evidence |
|---|---|
| A3 acceptance | `doc/ccp/slices/CCP-A3-acceptance.md` (72 h expiry, lazy expiry TD-A3-10 `:204`, state table `:93-99`) |
| A6 acceptance | `doc/ccp/slices/CCP-A6-acceptance.md` (`APPLY_FAILED` retryable `:44`, `:210`; held activation flag `governed_subscription_open` `:92`; TD-A6-5 `:242`) |
| C1 acceptance | `doc/ccp/slices/CCP-C1-acceptance.md` (TD-C1-7 `:205` operator retry / audit "D5 runbook / D3"; TD-C1-10 `:208` never-confirmed pending command "For D3 (observability)"; TD-C1-11 `:209` inbox retention) |

## 3. `path:line` re-verification (at `6b5051a8`)

| Fact | Location |
|---|---|
| `CommercialChangeRequest` states incl. `APPLY_FAILED`, `expires_at` | `libs/subscription/prisma/schema.prisma:492-532` |
| `BillingReconciliationFlag` (`reason`, `resolved_at`) | `libs/subscription/prisma/schema.prisma:320-333` |
| `BillingProviderCommand` (`state`, `provider_accepted_at`, `failed_at`, `last_error_code`) | `libs/subscription/prisma/schema.prisma:612-648` |
| `BillingWebhookInbox` (`status`, `last_error`) | `libs/subscription/prisma/schema.prisma:654-681` |
| D1 run log `UsageRollupRun.reconciliation IN ('RECONCILED','NOT_RECONCILED')` | `git show 73c33238:libs/subscription/prisma/migrations/20261025240000_ccp_d1_usage_rollups/migration.sql` (the `UsageRollupRun` CREATE) |
| Existing operator read pattern (read-only controller, keyset cursor, `assertPlatform`) | `apps/platform-admin/src/app/platform/platform-commercial-billing.controller.ts` |
| Existing background-job pattern (env-gated interval + one structured JSON log line per run) | `apps/platform-admin/src/app/platform/personal-signup-attempt-purge-sweeper.service.ts:25-90` |
| Scope holders: `platform:billing:read` (5 CCP roles, not catalog_manager), `platform:approval:read` (6 CCP roles); super_admin holds neither | `libs/identity/prisma/seed.ts:3240-3297` |

## 4. Observability pattern found, and the choice (D3-C1)

**Found:** no metrics library (no `prom-client`, OpenTelemetry, Sentry or CloudWatch dependency in `package.json`), no alert or notification mechanism. Background jobs log one structured JSON line per run through the NestJS `Logger` (the sweeper above, C1's worker, D1's worker).

**Chosen (the narrowest one, as instructed):**
1. **An operator-visible alert record:** a new table `subscription."CommercialOperationalAlert"`. One OPEN row per (alert type, subject) by a partial unique index; OPEN → RESOLVED only; RESOLVED is terminal; identity columns immutable; DELETE rejected (trigger). It is the exception register.
2. **A structured log event** per raise and per resolve (`ccp_alert_raised`, `ccp_alert_resolved`) and one summary line per scan (`ccp_alert_scan`).
3. **A background scanner, off by default** (`CCP_ALERTS_ENABLED=1` turns it on), in `apps/platform-admin` (D1's precedent). No external paging service.
4. **Read routes only** (no mutation from the console, A1-2): alert lists and counts-and-states metrics.

## 5. Choices left to this record

| ID | Choice | Needs confirmation? |
|---|---|---|
| D3-C1 | The alert mechanism (§4) | Recorded (instructed) |
| D3-C2 | **Alert types (closed set, CHECK):** BILLING family: `COMMAND_PENDING_PROVIDER_STUCK`, `COMMAND_FAILED`, `HELD_ACTIVATION`, `WEBHOOK_INBOX_FAILED`, `USAGE_NOT_RECONCILED`. APPROVAL family: `APPLY_FAILED`, `APPROVAL_NEARING_EXPIRY`, `APPROVAL_PAST_EXPIRY`. | Recorded |
| D3-C3 | **Thresholds.** No LOCKED policy value covers alerting lead times. Both are operational settings, not commercial policy (they change no request, approval, price or expiry; the 72 h expiry stays the policy's): `CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES` (default 1440 = 24 h; a command PENDING_PROVIDER since `provider_accepted_at` for at least this long), `CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES` (default 720 = 12 h; a PENDING_APPROVAL request whose `expires_at` falls within this lead). Scanner interval `CCP_ALERTS_INTERVAL_MS` (default 300000, minimum 10000). Each is env, documented, with docker-compose passthrough. | Recorded; the defaults are for the PO to confirm at the acceptance review |
| D3-C4 | **D1 source without D1 code.** `USAGE_NOT_RECONCILED` reads the latest `UsageRollupRun` per metric by raw SQL, guarded by `to_regclass`. When the table is absent (this baseline) the source reports `unavailable` and raises nothing. The integration test creates a stand-in table with D1's committed column names. After the lead merges D1, the real table is read. | Recorded (merge item) |
| D3-C5 | **Exception management** = the alert register's lifecycle. An alert resolves itself when the next scan no longer sees the condition, and the resolution records what the subject became. Resolution of the underlying condition stays on the governed paths (retry, change request, conversion); D3 adds no acknowledge, mute or retry route. | Recorded; an acknowledge route would need a scope (catalog change) |
| D3-C6 | **Scopes:** billing-family routes under `platform:billing:read`; approval-family routes under `platform:approval:read`. No new scope. | Recorded |
| D3-C7 | **Metrics are counts by state only** (commands by state, inbox by status, open flags by reason, change requests by state, open alerts by type). Never per tenant, never ordered by tenant, never money, no derived index or grade (PLATFORM-UX-1 `:139`, R-19). | Recorded |
| D3-C8 | **UI.** The CCP-UI v1.0 handoff (`Platform-Admin-prototype/ccp/CCP-UI-v1_0/`, `MANIFEST.sha256` verified: 5 / 5 OK; manifest SHA-256 `12aa308b7b781fe6c1a8ba929f5c6ab162244e5f47937f2b991b674120f7d65e`) pins **no** alert, exception or observability surface. Its `role="alert"` uses are inline banners on other slices' screens (B1/B3/B5). So D3 ships backend and read routes only; **the D3 UI needs a design release.** | Recorded |

## 6. Expected overlap with parallel slices (for the lead)

`schema.prisma`, `src/index.ts`, `subscription.module.ts`, `platform.module.ts`, `openapi/platform.yaml`, `ci/config/api-surface-manifest.json`, the platform-web consumer Pact and `verify-platform-admin.ts`, `.env.example`, `.env.prod.example`, `docker-compose.prod.yml`, `doc/generated/repo-map.*`. The migration `20261026090000_ccp_d3_operational_alerts` sorts after every earlier program migration, including D1's `20261025240000`.

## 7. Correction-1 triggers (PBD §2.4)

None. No architectural change (an additive table, a read surface, an opt-in job), no new regulatory or commercial decision (thresholds are operational and configurable, D3-C3), no governing-contract amendment.
