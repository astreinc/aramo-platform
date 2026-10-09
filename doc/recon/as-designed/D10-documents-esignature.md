# D10 — Documents & E-Signature (AS-DESIGNED anchors)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED

Ratified intent only. Sources are LOCKED directives in the canonical directives
store (OneDrive `Aramo/locked`) and `doc/adr/*`. Not synthesized from code.
Where the repo carries no ratified anchor for a code behavior, that is stated
explicitly.

## Governing ratified sources (anchors)

- **Parent architecture:** `Aramo-DOC-Documents-and-Native-ESignature-Architecture-and-Build-Directive-v1_1-LOCKED.md` (canonical: OneDrive `Aramo/locked`). The single authoritative DOC program directive; v1.0 draft superseded in full (§Supersession, line 21).
- **Slice directives:** `Aramo-DOC-1a-Documents-Core-Slice-Directive-v1_0-LOCKED`, `-DOC-1b-TalentDocument-Reconciliation-Slice-…`, `-DOC-2-Templates-Rendering-Requirements-Slice-…`, `-DOC-3-Native-ESign-Service-Core-Slice-…`, `-DOC-4-Sign-Web-Execution-Evidence-Slice-…`, `-DOC-4C-Dedicated-Contract-Closure-…`, `-DOC-5-RTR-Vertical-Slice-…`, `-DOC-6-Offer-Document-Vertical-Slice-…`.
- **E-Sign follow-ons:** `Aramo-E-Sign-Independent-Digital-Signature-Platform-Directive-v1_0-LOCKED` (OC v2), `-E-Sign-Operational-Closure-Implementation-Directive-v1_0-LOCKED`, `-E-Sign-Product-Experience-V1-Implementation-Directive-v1_0-LOCKED` (PX-V1), `-E-Sign-Standalone-Service-Architecture-Intent-v1_0-LOCKED`, `-E-Sign-Dedicated-Prod-and-Subscription-Backlog-…`.
- **ADR:** `doc/adr/0033-cross-service-durable-event-foundation.md` (Accepted 2026-10-07) — cross-service durable event transport.
- A repo copy of the PX-V1 implementation directive (non-LOCKED, backlog form) exists at `doc/backlog/Aramo-E-Sign-Product-Experience-V1-Implementation-Directive-v1_0.md`.

## Product & topology intent

- **Separation of concerns (§1, §2, line 72/81):** Documents owns canonical
  document identity/content/revisions/requirements; Native E-Signature owns who
  was requested to sign, how authenticated, what they viewed/accepted/signed,
  when, and the evidence that proves execution.
- **Deployment topology — RULED (§3, line 102):** Native E-Signature SHALL be a
  separate application `apps/esign-service` with its own `esign` PostgreSQL
  schema, API, state machine, execution ledger, and signing-session authority, on
  the shared PostgreSQL instance — justified by a distinct threat model (public
  signer traffic, capability-token auth, signature-execution authority,
  legal/evidence responsibility, future third-party provider equivalence).
- **Source-of-truth boundaries (§4, line 112):** E-Sign schema = signature
  execution/evidence truth; Documents schema = document identity/content truth.
- **ATS-neutral E-Sign (DOC-3 schema header; §10 R7):** `esign` references
  Documents only by opaque UUID — no cross-schema FK, no ATS import.

## Documents domain model intent (§5, §6)

- **R2 (§5, line 140):** `talent_evidence.TalentDocument` is a Talent-specific
  projection/reference to `documents.Document` (ADD-not-rename; `TalentDocument.id`
  stays stable). DOC-1b rules the backfill: one TalentDocument → a quartet
  (`Document` + `DocumentRevision` + `DocumentArtifact` + `DocumentAssociation`
  resource_type=TALENT); link is UUID-only, nullable, no cross-schema FK
  (DOC-1b R-1b-1, R-1b-6).
- **R3 (§5, line 146):** `libs/attachment` is RETAINED as the low-level file
  facility and is NOT expanded into the Documents aggregate; not every Attachment
  becomes a Document.
- **DocumentAssociation (§6.8, line 176):** the ONLY polymorphic table, controlled
  vocabulary (PO refinement 2026-09-21).
- **TemplateVersion immutable after activation (§6.3, line 160).**
- **DocumentArtifact belongs to a Revision (§6.11, line 192).**
- **DocumentEvent append-only (§6.12 / R20, line 195/302).**

## Storage, retention, evidence intent

- **Storage abstraction R4 (§7, line 200)** + **Tenant-selected storage R5 /
  R27.3 (§8, line 213).**
- **Retention & immutability R6 → WORM/Object Lock + legal hold R27.1 (§9, line
  219; Mandatory Scope item 9, line 349).**
- **Evidence integrity R19 (§11, line 261):** describe evidence as append-only /
  hash-verifiable / cryptographically signed / storage-immutability capable —
  never as legally "tamper-proof." **KMS-backed evidence-manifest signing is
  mandatory (R27.2, Mandatory Scope item 10).**
- **ExecutionCertificate (§11, line 266):** human-readable PDF (envelope id,
  document ids, source/executed hashes, signer names, masked signer contact, auth
  method, delivery/view/consent/sign + completion timestamps, execution method,
  evidence reference); the certificate itself becomes a Documents artifact.
- **Permanent artifact ownership (§11, line 268):** E-Sign produces executed
  bytes + evidence manifest + certificate and hands them to Documents, which
  stores `EXECUTED` and `EXECUTION_CERTIFICATE`, verifies hashes, records artifact
  identity. **E-Sign MUST NOT become a second long-term document repository.**

## Native E-Sign bounded context intent (§10)

- Signature representation (§10.5, line 244): native v1 supports `TYPED, DRAWN`;
  room for `UPLOADED, DIGITAL_CERTIFICATE`; never treat the visual glyph alone as
  the legal record.
- SignerDisclosureAcceptance R16 (§10.6, line 246); SigningSession R17 (§10.7,
  Portal magic-link precedent, line 249); SignatureEvent append-only R20 (§10.9,
  line 255).

## Async integration + idempotency intent (§13, §14, §16)

- **R13 (§13, line 280):** outbox is log-only today; no fake cross-service
  transaction — `transaction + outbox + idempotent consumer + correlation ID`;
  all transitions replayable. Idempotency via the canonical `IdempotencyService`
  (`Idempotency-Key` → `(tenant_id, key)` unique + sha256 request-hash) — required
  on create/prepare/create-envelope/send/complete/store-executed/consume-completion.
  **Duplicate requests may never create duplicate legal/evidence records.**
- **R15 mail delivery (§15, line 298):** E-Sign depends on `SigningNotificationPort`;
  composition root binds SES Mailer / Microsoft Graph; E-Sign MUST NOT import
  provider SDKs directly. Notification kinds `SIGNATURE_REQUEST,
  SIGNATURE_REMINDER, SIGNATURE_COMPLETED, SIGNATURE_DECLINED, SIGNATURE_EXPIRED`.
- **Operational external async delivery R27.4 (Mandatory Scope item 12, line
  349):** transactional outbox, external publish, idempotent consumers, replay
  safety, retry/backoff, dead-letter, correlation IDs, tenant context, event
  schema/version, observability, **no bytes/PII in messages.**
- **ADR-0033 (Decision 1):** EventBridge is the default Aramo cross-service
  domain-event router, replacing the ADR-0018-deferred SNS router; SNS remains
  approved but is no longer a mandatory hop. Business code must not call
  EventBridge/SQS/AWS SDK directly — AWS concerns sit behind ports/adapters.

## Authorization intent (§18 R22, line 337)

Start with a minimal authority set conforming to `SCOPE_KEY_FORMAT` — explicitly
listed: `document:read, document:create, document:manage, document:execute,
document_template:read, document_template:manage, document_requirement:read,
document_requirement:manage, document_evidence:read, document_storage:manage`.
Split further only where a demonstrated boundary requires it; `document:read`
must never become a backdoor around financial field authorization. The E-Sign
PX-V1 product scopes (`esign:envelope:read/create/send`) are ratified by the
PX-V1 LOCKED directive (PX-3), as a dedicated E-Sign product namespace distinct
from the ATS `document:*` scopes.

## Build sequence intent (§20 R24, line 357)

DOC-3 = Native E-Sign Service Core (`apps/esign-service`, `esign` schema,
envelope/signer/field/session/disclosure/event, `SignatureProvider` contract,
`NativeAramoSignatureProvider`, capability tokens, state machines, idempotency,
expiry, decline, void; must remain ATS-neutral). DOC-4 = Sign Web + Execution
Evidence (`apps/sign-web`, `scope:sign`, `sign.aramo.ai`; **document review**,
electronic disclosure, typed & drawn signature, required-field completion,
executed-document production, source/executed hashes, evidence manifest +
`EvidenceManifestSignerPort`, execution certificate, secure completion callback,
notification delivery). *DOC-4 Acceptance (line 364):* a non-Aramo-account
external signer can securely execute a document end-to-end; Documents receives
immutable signed artifacts plus verifiable evidence.

## Explicit anchor gaps (no ratified intent located in-repo)

- The detailed section text of the DOC slice / E-Sign follow-on LOCKED directives
  lives in the OneDrive canonical store, NOT in the repo `doc/` tree (only the
  parent architecture directive's headings were readable in this pass). Section
  numbers above are from the parent architecture directive; slice-level rule ids
  (R-3-3, R-4-3/6/7/8, R-5-5/12, R-6-4, PX-V1 F1/F2/F3, OC v2 §8/§11/§28/§31.10)
  are cited by code comments, not re-verified against the directive bodies here.
- No `doc/adr/*` entry specifically ratifies the Documents or E-Sign schema; the
  schema authority is the LOCKED directives. ADR-0033 governs only cross-service
  transport.
- No ratified anchor was located stating that Sign Web must fetch the signer
  document view / source bytes before signing (the DOC-4 "document review"
  acceptance implies it, but the explicit F3 wiring requirement is in the PX-V1
  directive body, not confirmed in-repo this pass).
