# ADR-0036: Talent Intelligence as an Independent Service (ATS / TI Separation)

**Status:** Accepted

**Date:** 2026-10-23

**Governing directive:** ATI-SEP-1 —
`Aramo-ATS-TI-Separation-Program-Directive-v1_0-LOCKED.md`
(SHA-256 `fb9918dbaf2bbef2c6cf0bbd25845ad4a179528f9165b2ed6ef1f1efbe955c83`)
plus Addendum A1 (erasure semantics) and Addendum A2 (PO rulings: Draft → Review → Save; business-fact event names; ATS keeps sourcing, screening, advisories, matching and decisions).

**Supersedes (for Talent Intelligence only):**
[ADR-0029](0029-pipeline-boundary-modular-monolith.md) :63 ("share a repo and a
database instance … until a forcing function arrives"). The forcing function is
named in Decision 2. The trust/intelligence invariants of the Talent-Lifecycle
& Trust Spec v1.1 listed in ATI-SEP-1 §2 are superseded by ATI-SEP-1 §3.

---

## Context

Before this ADR, Talent Intelligence (TI) lived inside the ATS deployable:

- The `scope:cip` libs `talent-trust`, `identity-index`, `sourced-talent`,
  `platform-trust` and `talent-reconcile` shared the one `DATABASE_URL`, the
  one migration ledger and the one `api` process.
- The recruiter Add Talent request wrote the trust ledger synchronously:
  - `recordDeclaredClaimIfAbsent` from `talent-extraction`;
  - a global `APP_INTERCEPTOR` that minted EMAIL/PHONE anchors and ran the
    same-human matcher on talent-record writes.
- The ledger was tenant-partitioned. It had no Golden subject and no
  cross-tenant evidence.

The PO decision of 2026-10-23 makes TI an independently subscribable product
with global Golden evidence. ATS Add Talent must succeed when TI is
unsubscribed, unavailable, slow or degraded.

## Decision

### 1. Two products, one contract

| | ATS (`apps/api`, `apps/ats-web`) | TI (`apps/talent-intelligence-service`) |
|---|---|---|
| Talent identity | `TalentRecord.id` (canonical) | `GoldenTalent.id` = `intelligence_subject_id` (canonical); ATS id is an external reference |
| Evidence | `talent_evidence` (tenant-owned ATS evidence of record) | `intelligence` schema (global assertions, provenance, trust) |
| Create path | all-or-nothing ATS write + ATS outbox | never on the ATS create path |
| Database | shared Aramo DB (`DATABASE_URL`) | own database `aramo_intelligence`, own role (`INTELLIGENCE_DATABASE_URL`) |
| nx tag | `scope:ats` | `scope:intelligence` |

Dependency rules (CI-enforced in `eslint.config.mjs`):

- `scope:ats` must not depend on `scope:intelligence`.
- `scope:intelligence` must not depend on `scope:ats` or `scope:cip`.
- Both may depend on `scope:shared`.

The only shared code is `libs/intelligence-contracts` (`scope:shared`): event
and API DTOs, the admission field catalogue, and validators.

### 2. Own database (the forcing function)

TI holds global, cross-tenant evidence under a different access model
(subject-scoped access) and a different retention model (Addendum A1 audit
retention). Isolating it in its own database and role is what makes "ATS
cannot read TI storage" structural rather than conventional. That is the
forcing function ADR-0029 required.

- **Database:** `aramo_intelligence` on the existing Postgres server, with role
  `aramo_intelligence`. The database can later be lifted to its own host by
  changing only the URL.
- **Migrations:** `libs/intelligence-core/prisma/migrations`. They are applied
  by a per-database runner (`tools/db-sync-intelligence.sh`) with its own
  ledger table `public._intelligence_migrations` in the TI database.
  `deploy/migrate-prod.sh` invokes it after ensuring the database and role
  exist (idempotent; the PROD volume is not fresh, so `initdb` scripts cannot
  be relied on).

### 3. Integration

**ATS → TI**

- An ATS outbox lives in schema `talent_record`, shaped like
  `TalentIntakeOutboxEvent` (ADR-0033 envelope plus lease columns).
- Events: `talent.created`, `talent.profile_updated`, `talent.erased`
  (`event_version: 'v1'`). The envelope carries ids only: no PII and no
  document references.
- The ATS Intelligence Publisher drains that outbox. For a tenant with the
  `intelligence` capability it:
  - reads committed ATS data;
  - builds the allowlisted admission payload (`libs/intelligence-contracts`);
  - calls `POST /v1/ingest/talent` with a service token.
- An unentitled tenant's events are marked published with outcome
  `NOT_ENTITLED`.

**TI → ATS**

- TI writes `golden_talent.profile_updated` to its outbox and delivers it as an
  HMAC-signed webhook, following the `aramo-sign-s2s-v1` pattern, to
  `POST /v1/integrations/intelligence/events` on the ATS.
- The ATS Inbound Sync then reads `GET /v1/references/{tenant}/{talent}/profile`
  and applies the per-tenant field sync policy:
  - auto-apply low-risk, non-conflicting values;
  - route conflicting or sensitive values to `TalentRecordReconcileContradiction`
    and `TalentProfileFieldState` for review;
  - never overwrite recruiter-confirmed values.
- It records `intelligence_link(talent_id, intelligence_subject_id)`.

**Service auth (E-2)**

- API calls use a client-credentials token exchange issued by TI.
  ATS env: `INTELLIGENCE_ATS_CLIENT_ID`, `INTELLIGENCE_ATS_CLIENT_SECRET`.
- Webhooks are HMAC-signed with `INTELLIGENCE_WEBHOOK_SIGNING_SECRET`.

**Idempotency**

- TI keeps an inbox keyed by the source `event_id`.
- Ingestion is idempotent on
  `(source_system_id, source_tenant_id, external_talent_id, source_event_id)`.

### 4. Admission contract

These are enforced server-side in TI. The sender's labels are never trusted.

**Class A — shared professional evidence**
- skills
- work history
- education
- certifications
- projects
- current employer and title
- professional location (city / region / country)
- public professional URLs
- availability (temporal)

**Class B — controlled identity and eligibility**
- names
- emails and phones (shared with linked, entitled tenants)
- work-authorization eligibility assertion (résumé-sourced values are
  non-authoritative, per TI-1G)
- verification outcomes

**Class C — never admitted**
- notes
- pay
- source
- hot flag
- requisition, pipeline, submittal and interview data
- street address and postal code

**Documents**
- The ingestion schema is closed: unknown keys return 400.
- Any key naming bytes, files, attachments, storage keys, presigned or
  document URLs is rejected structurally.
- Provenance may carry only an opaque `source_document_hash` (D-7).

### 5. Identity resolution (G4)

1. An existing `(source_system_id, source_tenant_id, external_talent_id)` is
   authoritative. Changed identity data produces an `IdentityConflict`, never
   a new subject.
2. A `VERIFIED` email, phone or government-identifier token bound to exactly
   one active subject links deterministically. Primary/secondary position is
   irrelevant. A partial unique index makes a verified identifier bind to at
   most one subject.
3. Unverified matches are discovery only. With no verified anchor match, TI
   creates a `PROVISIONAL` subject.
4. Same verified anchor with conflicting attributes: same subject, plus an
   `IDENTITY_ATTRIBUTE_CONFLICT`. It is never labelled fraud.
5. Merge and split are reversible and recorded in `MergeSplitEvent`, with
   assertions and references re-pointed.
6. Government identifiers are stored only as a keyed HMAC token
   (`INTELLIGENCE_GOV_ID_TOKEN_KEY`) plus jurisdiction and class. Raw values
   are never stored.

Verification v1 is a talent email OTP, initiated through the portal and
executed by TI.

### 6. Access (ATI-SEP-1 §3.4, Addendum A1)

- A tenant reads a subject only when it holds:
  1. the `intelligence` capability, **and**
  2. an `ACTIVE` `ExternalTalentReference` for that (tenant, talent).
- Knowledge of a subject id grants nothing.
- With `TI_CROSS_TENANT_READ_ENABLED=false` (the default, pending Legal L-1),
  the read API returns only assertions contributed by the requesting tenant,
  plus TI-acquired artifacts. With `true`, it returns the full Golden evidence.
- Erasure:
  - `talent.erased` sets the reference to `ERASED`.
  - A subject with no `ACTIVE` reference becomes `AUDIT_RETAINED`, and no
    tenant read path returns it.
  - Evidence is never deleted by a single tenant's erasure.
- TI-acquired artifacts are returned only when
  `DocumentTypePolicy.globally_shareable` is true.

## Consequences

- Add Talent has no TI dependency, enforced by:
  - lint (`scope:ats` → `scope:intelligence` is forbidden);
  - the module graph (TI libs are absent from `apps/api`'s create path);
  - tests that create a Talent with TI unreachable.
- The legacy trust substrate (`talent-trust`, `identity-index`,
  `platform-trust`, `talent-reconcile`, the trust UI/API surfaces) is retired
  in T10. Its data is not migrated (clean rebuild; backfill by replay).
  Re-pointing follows Addendum A2 F-1:
  - Evidence, verification, trust, disputes, proposals and attestations move
    to TI.
  - Sourcing (`sourced-talent`), screening, within-tenant identity/duplicate
    advisories, matching and every recruiter decision stay in ATS. Advisories
    are re-implemented on ATS data.
  - TI output is enrichment only and never gates an ATS decision.
- Skills taxonomy and matching configuration are platform-owned. They are
  governed from `apps/platform-admin` (Addendum A2 A-c).
- A second migration ledger and a second database are new operational
  surfaces, with a runbook in `deploy/migrate-prod.sh`.
