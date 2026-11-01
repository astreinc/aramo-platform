> **Withdrawn by Amendment A5** (`Aramo-Sign-Feature-Parity-Program-Directive-Amendment-A5-Personal-Stays-Personal-v1_0-LOCKED.md`, PO 2026-11-01): Personal stays Personal; the upgrade code has been removed. Historical record only.

# Aramo Sign — Personal → Business upgrade: recon

Governing: `Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED.md` (SHA-256
`2bd74ca5756eb4efab7e68a8a4d052d2388b97943837380ef583e0508f49f2ea`), §5 "Related work":
"A Personal account becomes a Business organization and keeps its envelopes, evidence and
custody. Recon first, then build; dark until the PO enables it."

Substrate: `origin/main` at `06372585` (2026-11-01).

## 1. Conclusion — upgrade IN PLACE

The upgrade flips `identity.Tenant.kind` from `PERSONAL` to `BUSINESS` on the same row. No
new tenant is created and nothing is moved.

Why:

- **Envelopes, evidence and the ledger hash chain are keyed by `tenant_id` only.** Nothing
  under `libs/sign` reads the tenant kind (a sweep of `libs/sign/src/lib` finds no
  `PERSONAL` / tenant-kind branch). A move would re-key every envelope, signer, ledger
  event and executed-artifact row, and the evidence hash chain covers those rows — a
  move would break the chain or require re-attestation. In place changes none of them.
- **Custody object keys embed the tenant id.** `SIGN_ARTIFACT_KEY_ROOT = 'tenants/'`
  (`apps/sign-service/src/app/custody/sign-artifact-storage.config.ts:119`) and the
  `tenants/<tenant>/envelopes/<envelope>/` prefix (`sign-artifact-store.ts:70`). The
  custody bucket is Object-Lock protected (Sign Executed-Artifact Custody v1.0), so
  objects cannot be copied-and-deleted to a new prefix. In place keeps every key.
- **Retention is per tenant id.** `SignTenantRetentionPolicy` (`libs/sign/prisma/schema.prisma:915`)
  is keyed by `tenant_id`; the purge queue and legal holds are too. In place keeps the
  owner's retention choice and any hold.
- **Every Personal-only restriction is derived from `Tenant.kind` at request time**, so
  flipping the kind lifts them without touching their stores (§3).

A new-tenant-plus-move design was rejected: it would need cross-schema re-keying of the
sign, identity, subscription, metering and entitlement schemas, could not move
Object-Lock custody objects, and would change the evidence chain.

## 2. Substrate audit

| Area | Where | Finding |
|---|---|---|
| Tenant kind | `libs/identity/src/lib/util/tenant-kind.ts`; `Tenant.kind` `libs/identity/prisma/schema.prisma:68` | String vocabulary `BUSINESS`/`PERSONAL`, app-enforced, no DB CHECK, no trigger reads it. |
| Personal provisioning | `apps/platform-admin/src/app/signup/personal-signup.service.ts:83,537-580` | Owner gets `tenant_owner` ONLY (directive v1.1 §4 correction A); capabilities `[core, sign]`; IdP pin enforced to `google`; `allowed_domain` NULL; tenant name `"<display name> (Personal xxxxxxxx)"`. |
| Business provisioning | `apps/platform-admin/src/app/signup/sign-signup.service.ts` | Owner gets `tenant_owner` + `tenant_admin` (ROLES-1 PR-2 §6); capabilities `[core, sign]`; US organization details validated by `validateUsOrganizationDetails` + `authority_attested`; profile columns on the tenant; `OrganizationRegionService.lockUs` + `recordAttestation`; work email required; domain claim (P3) held; Business ToS accepted only if APPROVED. |
| Personal send gate | `apps/sign-service/src/app/personal/personal-send.gate.ts`; `sender-envelope.service.ts:990,1032` | Runs only when `tenant.kind === 'PERSONAL'`. |
| Personal legal | `apps/sign-service/src/app/legal/personal-legal-status.service.ts:85,109` | Pending Personal documents only for `PERSONAL`. |
| Abuse reports | `apps/sign-service/src/app/personal/sign-report.service.ts:134` | Automatic pause only for `PERSONAL` senders. |
| Workspace | `apps/sign-service/src/app/sender/sender-context.service.ts:145-191` | `personal` vs `business` workspace and authority derived from kind. |
| Envelope reads | `sender-envelope.service.ts:172` | BUSINESS + `ENVELOPE_READ_ALL` reads all; otherwise own. Unchanged for a one-member org. |
| Account close | `apps/sign-service/src/app/account/sign-account.service.ts` | PERSONAL-only; a BUSINESS account is closed by its organization. |
| Risk state | `identity.TenantRiskState`, `PersonalRiskService` | Personal-only state; kept as evidence after upgrade (not read for BUSINESS). |
| FREE subscription | `libs/subscription/src/lib/free-personal-subscription.ts` | System-opened, `source FREE`, plan `aramo-sign-free-personal-v1` (`tenant_kind PERSONAL`), monthly 5 + daily 2 windows; lazily reopened by `ensure()` only for PERSONAL. |
| Paid Personal | PR #1047 (unmerged, `feat/sign-catalog-v2`) | Adds Standard ($10) Personal paid checkout. Not on main. |
| Plan/kind rule | `commercial-apply.service.ts:969` | CCP refuses a plan whose `tenant_kind` differs from the tenant's. |
| Legal registry | `libs/subscription/src/lib/legal/legal-documents.ts` | `sign.terms_of_service` is **0.1.1 DRAFT** (no APPROVED Business terms). ToS v2.0 combined is approved by the PO but is **not** in the registry. |
| Legal acceptance | `LegalAcceptanceService.recordInApp` | Context CHECK admits `SIGNUP`, `CHECKOUT`, `IN_APP`; `IN_APP` is idempotent per user, tenant, document and version. |
| Audit | `libs/identity/src/lib/audit/identity-audit.repository.ts` | Closed app-level `EVENT_TYPES` (no DB CHECK); spec pins the count. |
| DB roles | `deploy/db-roles/aramo-domain-roles.sql:50` | `aramo_sign_rw` may write `identity` and `subscription`: sign-service may host the upgrade. |
| Role grants | `UserTenantMembershipRole` triggers | Only the last-owner invariant; nothing restricts `tenant_admin` by kind. |

## 3. Personal-only restrictions and how the upgrade lifts them

| Restriction | Store | Lifted by |
|---|---|---|
| Personal send gate (risk, young account, location) | kind check | kind flip |
| Personal legal re-acceptance | kind check | kind flip |
| Abuse-report automatic pause | kind check | kind flip |
| Monthly 5 / daily 2 allowance, 15 MiB, no invites | FREE plan allowances | ending the FREE subscription |
| `personal` workspace, own-envelopes-only | kind check | kind flip |
| Owner holds `tenant_owner` only | membership roles | upgrade adds `tenant_admin` |

## 4. Build (dark)

- `SIGN_PERSONAL_UPGRADE_ENABLED` (unset = off): both routes answer 404 and the Settings
  card is hidden.
- `GET /v1/sign/account/upgrade` — eligibility, the Business terms to accept, the current plan.
- `POST /v1/sign/account/upgrade` — owner only; `confirm: "UPGRADE"`; organization name;
  US organization details + authority attestation (the Business signup A1 requirements);
  `accept_terms: true`.
- Order: validate → record the Business terms acceptance (`IN_APP`) → end the FREE
  subscription (billing lock) → ONE identity transaction: compare-and-set the kind
  (`PERSONAL`→`BUSINESS`), rename, write the profile, US region lock, authority
  attestation, add `tenant_admin`, bump the owner's authorization version, audit
  `identity.tenant.upgraded_to_business`. If the identity transaction fails the tenant is
  still PERSONAL and the FREE subscription reopens lazily on the next read.
- After the upgrade the organization has no subscription; the owner chooses a Business
  plan on the existing Billing page (same as a new Business signup).

## 5. Decisions needed (conservative choice taken, dark)

1. **Business terms are not approved in the registry.** `sign.terms_of_service` is
   0.1.1 DRAFT; ToS v2.0 combined is not registered. The upgrade **refuses**
   (`business_terms_not_available`) until an APPROVED, effective version is in the
   registry. It does not fall back to "no terms" as Business signup does.
2. **Paid Personal (PR #1047).** Cancel/prorate of a Stripe Personal subscription is not
   built: an open subscription that is not `FREE` refuses the upgrade
   (`personal_paid_subscription_upgrade_unsupported`). Needs a Lead/PO ruling on proration
   and is built after #1047 merges.
3. **No email domain lock.** Personal owners use personal addresses, so the upgraded
   organization keeps `allowed_domain` NULL and holds no domain claim (P3). The invite
   domain lock allows through on NULL. Needs a Lead ruling (e.g. require a verified work
   domain before inviting).
4. **US only.** Business requires US organization details (Sign Signup A1); a Personal
   account in India cannot upgrade.
5. **Sign-in provider stays pinned to Google** (the Personal pin). Members invited later
   sign in with Google.
6. **Good standing.** Only an ACTIVE account whose risk state is `clear` (no review owed,
   no restriction, not closed) may upgrade.
7. **Irreversible.** There is no Business → Personal path.
