# CCP-C5 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §2.3 and §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-C5: tax |
| **Schedule row** | PBD §5.2, row C5 (binding), `:95` |
| **Branch / baseline** | `wip/ccp-c5` at `41a0e3b5` ("CCP: record Architect program acceptance disposition …"). Working tree clean at start (the one untracked file in the primary checkout is not in this worktree). |
| **Drift since the previous slice** | None. The baseline is the integrated program head carrying C1, C2, C3, C6, B3 and the Architect disposition (`doc/ccp/decisions.md:120-165`). |

## 1. Governing instruments (SHA-256 re-verified against the `.sha256` sidecars: MATCH)

| Instrument | SHA-256 |
|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` |
| `Aramo-CCP-Program-Charter-v1_0-LOCKED.md` | `82d328eb11b586eb0df5d183d9c88c6899053c9257be7b5245f77e212c54b788` |

Clauses relied on (`path:line` in OneDrive `Aramo/locked`):
- PBD `:95` (row C5): "**In:** designed disabled states only, until registration. **Out:** live tax calculation | Disabled-state tests | Revert | Any tax calculation before registration | NOT DELIVERED until registration (§10)".
- PBD `:87`: "All Phase C slices run in **Stripe test mode** with designed disabled states (§10)."
- PBD `:209` (§10): "| C5 tax | Stripe Tax registration |".
- Charter `:92`: "Payments, invoices, tax, card data, proration, dunning retries | **Stripe** | Aramo SHALL mirror status only."
- Charter `:366`: the external items "stay outside this charter … Stripe Tax registration".
- Architect disposition, `doc/ccp/decisions.md:156`: "C4, C5 and C7 SHALL be built in Stripe test mode with the designed disabled states and reported NOT DELIVERED until their external decision is verified. **No scope amendment is needed.**"

## 2. Prerequisites (row C5: "C1 evidence; external: Stripe Tax registration")

| Prerequisite | Evidence |
|---|---|
| C1 evidence | `doc/ccp/slices/CCP-C1-acceptance.md` (present at `41a0e3b5`) |
| External: Stripe Tax registration | **Not verified.** No registration is recorded anywhere in the repo, `doc/ccp/decisions.md` or the runbooks. **C5 is therefore built as designed disabled states only, and it is reported NOT DELIVERED.** |

## 3. `path:line` re-verification (at `41a0e3b5`)

| Fact | Location |
|---|---|
| **A live tax switch existed.** Checkout sent the provider's automatic-tax parameter when the env var `STRIPE_AUTOMATIC_TAX` was `1` | `libs/subscription/src/lib/billing/stripe-billing.provider.ts:218` |
| The variable was a prod compose passthrough for sign-service | `docker-compose.prod.yml:470` |
| It was documented in the operator contract ("1 enables Stripe Tax on checkout (default off)") | `.env.prod.example:334`, `:345` |
| It is also named in a historical rename record (the keys that kept their names at the Sign rename) | `doc/runbooks/RELEASE-sign-naming.md:65` |
| No other code path names a tax parameter: the checkout, account upsert, portal, cancel and expire writes and the three C3 reads carry none | `stripe-billing.provider.ts:189-254`; `stripe-billing-read.adapter.ts:85-101`; `stripe-wire.ts` |
| Only two classes talk to the provider (both read `STRIPE_SECRET_KEY`) | `stripe-billing.provider.ts:144`; `stripe-billing-read.adapter.ts:45` |
| The organization profile carries a `tax_id` (the organization's own registration number, Sign Signup A1 §2.2), but the billing-profile port does not, so it never reaches the provider | `apps/platform-admin/src/app/signup/sign-signup.service.ts:532`; `libs/subscription/src/lib/billing/organization-billing-profile.port.ts:21-25` |
| Reads that would show tax: C3 tenant billing status; the C6 renewals, outstanding-payments and reconciliation reports; the B3 tenant Commercial overview; the tenant Sign billing account | `billing-status-read.service.ts`; `billing-finance-report.service.ts`; `commercial-subscription-read.service.ts`; `subscription-lifecycle.service.ts:420` (via `apps/sign-service/src/app/billing/esign-billing.controller.ts:195`) |

## 4. Design input (PBD §2.5)

`Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/MANIFEST.sha256` (manifest SHA-256 `12aa308b7b781fe6c1a8ba929f5c6ab162244e5f47937f2b991b674120f7d65e`); all 5 entries checked OK (same pins as C3/C6).

- The v1.0 handoff lists **tax as out of scope** (`handoff/Commercial Control Plane - Claude Code handoff v1.0.md:33`: "- tax"). No tax element exists in the design file, `ccp-data.js` or the amendments log (a case-insensitive search for `tax` finds only that line).
- The "not enabled" state is requested for v1.1 (`documents/ARAMO-Claude-Design-Prompt-CCP-UI-v1_1-Finance-Ops-20261025.md:76-78`, SHA-256 `ac9bc7c9…`): "§3.7 Tax (C5): a disabled state only — wherever tax would appear (renewals, revenue, a tenant billing panel), show a designed **"Tax not enabled — pending Stripe Tax registration"** state. No tax calculation UI." No v1.1 release exists under `ccp/`.

**Decision C5-D0: C5 has no UI.** v1.0 pins no tax state, so a tax UI would be an unpinned design change. The backend state is built so the v1.1 screens can bind to it. No `apps/platform-web` or `apps/sign-web` file is touched.

## 5. Choices the schedule leaves to the record

| ID | Choice | Needs confirmation? |
|---|---|---|
| C5-D1 | **One constant state.** `taxAvailability()` always returns `{ enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' }` (a fresh object each time). It reads no env, setting or row. Enabling tax replaces the module in a future, separately authorized release. | No |
| C5-D2 | **Remove the existing switch** (`STRIPE_AUTOMATIC_TAX`) from the checkout code, the prod compose passthrough and the operator contract. No flag replaces it. It was the only reachable tax-calculation path, so it falls under the row's HALT ("any tax calculation before registration"). Removing it is the disabled state. | Recorded as a typed divergence (TD-C5-1) |
| C5-D3 | **Where the state appears:** C3 billing status (every availability), the 3 C6 reports, the B3 tenant overview and the Sign billing account. The C3 portal-configuration read, the B3 workbench list and the pre-CCP platform Sign tab (`platform-sign.controller.ts`) are left unchanged: no tax would appear there. | No |
| C5-D4 | **The guard** is test-level: a source scan of every billing root, plus a fake provider client (stubbed `fetch`) that records every request each Stripe adapter method can make, with every plausible tax switch set on. No runtime filter is added to the adapters. | No |

## 6. Migration and overlap

- **No migration.** No schema change.
- Expected merge overlap: `libs/subscription/src/index.ts`, the 4 read services, `stripe-billing.provider.ts`, `openapi/platform.yaml`, `openapi/sign.yaml`, the platform-web and sign-workspace Pact consumers, the C3/C6/B3 authorization specs, `docker-compose.prod.yml`, `.env.prod.example` and `doc/generated/repo-map.*`.

## 7. Correction-1 statement (PBD §2.4)

No correction-1 trigger has arisen. C5 needs no architectural change, commercial or regulatory decision, or contract amendment. The Stripe Tax registration is a §10 external dependency, not a trigger. Removing an unauthorized tax switch is what the row's HALT requires; it does not decide tax policy.
