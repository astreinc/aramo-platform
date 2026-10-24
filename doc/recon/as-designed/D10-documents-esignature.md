# D10 — Documents & E-Signature (AS-DESIGNED anchors)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED

Ratified intent only. Sources are LOCKED directives in the canonical directives
store (OneDrive `Aramo/locked`) and `doc/adr/*`. Not synthesized from code.
Where the repo carries no ratified anchor for a code behavior, that is stated
explicitly.

## Governing ratified sources (anchors)

- **Parent architecture:** `Aramo-DOC-Documents-and-Native-ESignature-Architecture-and-Build-Directive-v1_1-LOCKED.md` (canonical: OneDrive `Aramo/locked`). The single authoritative DOC program directive; v1.0 draft superseded in full (§Supersession, line 21).
- **Slice directives:** `Aramo-DOC-1a-Documents-Core-Slice-Directive-v1_0-LOCKED`, `-DOC-1b-TalentDocument-Reconciliation-Slice-…`, `-DOC-2-Templates-Rendering-Requirements-Slice-…`, `-DOC-3-Native-ESign-Service-Core-Slice-…`, `-DOC-4-Sign-Web-Execution-Evidence-Slice-…`, `-DOC-4C-Dedicated-Contract-Closure-…`, `-DOC-5-RTR-Vertical-Slice-…`, `-DOC-6-Offer-Document-Vertical-Slice-…`.
- **E-Sign follow-ons:** `Aramo-E-Sign-Independent-Digital-Signature-Platform-Directive-v1_0-LOCKED` (OC v2), `-E-Sign-Operational-Closure-Implementation-Directive-v1_0-LOCKED`, `-E-Sign-Product-Experience-V1-Implementation-Directive-v1_0-LOCKED` (PX-V1), `-E-Sign-Standalone-Service-Architecture-Intent-v1_0-LOCKED`, `-E-Sign-Dedicated-Prod-and-Subscription-Backlog-…`.
- **ADR:** `doc/adr/0033-cross-service-durable-event-foundation.md` (Accepted 2026-10-07) — cross-service durable event transport.
- **ADR-0034 (LOCKED, canonical store):** `Aramo-ADR-0034-Shared-Document-Template-Library-v1_0-LOCKED.md` (Accepted 2026-10-20, :3) — one template library, PLATFORM + TENANT owners (D1 :37), Platform-Admin-authored defaults (D2 :44), current-version-only (D3 :49), selection per type/client (D6 :69), Aramo variable catalog (D7 :78), branding (D8 :87), product tags recorded not enforced (D9 :91), withdrawal with notice and fallback (D10 :96), administration out of ATS (D11 :101), Sign uses the library only through the Documents API (D12 :114). D4/D5 (use a default without copying) are superseded by ORG-UX-1 adoption (below).
- **Aramo Sign product sources ratified after 2026-10-09** (all `*-LOCKED.md` in the canonical store):
  - `Aramo-E-Sign-ES-1-Lifecycle-Integrity-Implementation-Authorization-v1_0` (2026-10-15) — terminal envelope states irreversible, no signing after void/decline/expiry/completion, concurrency-safe transitions (:36). Its "no sequential signing" clause is superseded by Multi-Signer.
  - `Aramo-E-Sign-ES-2-Core-Service-Trust-Implementation-Authorization-v1_0` (2026-10-15) — authenticate Sign → Core service requests; retire the unused write-back HTTP route (B-3, :23); reverse API-to-Sign trust deferred (B-4, :24; later activated as Unified Product S-4); nginx defense in depth deferred (B-5, :25).
  - `Aramo-E-Sign-Production-Service-URL-Wiring-Authorization-v1_0` (2026-10-15) — service URL passthrough only; Sign deploys before the Core API.
  - `Aramo-E-Sign-Host-and-Workspace-Architecture-Ruling-v1_0` (2026-10-18) — BUSINESS `/sign/`, PERSONAL `/personal/`; host and separate sender-app clauses superseded by the Unified Product directive §4.1 and Addendum D-1.
  - `Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0` (2026-10-18) — plan authority, provider routing and signing engine kept separate; one provider per tenant (Aramo Sign, DocuSign, Adobe); provider frozen per request (:122); quota or outage never waives a required RTR (:113). Its 100-envelope monthly allowance (:18) is superseded for Business plans by Commercial Plans A1.
  - `Aramo-Sign-Standalone-Product-Final-Implementation-Authorization-v1_0` (2026-10-18) — Business self-signup and governed owner activation; Stripe authoritative for payment events, Aramo for entitlement. Its single paid plan, one-signer limit and host are overridden by Commercial A1, Multi-Signer and D-1.
  - `Aramo-Sign-Commercial-Plans-Legal-Framework-Amendment-A1-v1_0` (2026-10-19) — four plans (Free Personal, Standard Business, Standard Professional, Enterprise; table :31); Business plans unlimited (:14–:15) with metering; Professional bound to an ATS subscription (:44); legal texts remain DRAFT until approved.
  - `Aramo-Sign-PR967-Lead-Architect-Disposition-D16-D18-v1_0` (2026-10-19) — active ATS entitlement qualifies for Professional (D16, :12); unbuilt capabilities must not be advertised as available.
  - `Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0` (2026-10-19) — Sign is a standalone product and ATS a client; slices S-1 to S-7 (:142–:148).
  - `Aramo-Sign-Unified-Product-S6-ATS-Migration-Addendum-v1_0` (2026-10-19) — ATS on the Sign API via user delegation and an event-bound completion grant (:13); migration scope (:18); internal transport kept as fallback (:34); switching production to `api` not authorized (:38). Governs over the parent where they differ.
  - `Aramo-Sign-Unified-Product-D1-Host-Retirement-Addendum-v1_0` (2026-10-19) — `sign.aramo.ai` is the only Sign host; `esign.aramo.ai` "Retired entirely — no redirect" (:16). Overrides parent D-1 and S6 ruling 3.
  - `Aramo-Sign-Naming-Unification-Directive-v1_0` (LOCKED 2026-10-20) — `esign` identifiers become `sign` (schema, API `/v1/esign/*` → `/v1/sign/*` :124, auth consumer, roles, scopes, entitlement and subscription keys); no behaviour change; `ESIGN_*` error codes and `/v1/webhooks/esignature/*` keep their names.
  - `Aramo-Sign-Multi-Signer-Amendment-v1_0` (2026-10-20) — up to 10 signers (M-2 :25); sequential signing included (M-4 :29); routing mode `PARALLEL | SEQUENTIAL`, default PARALLEL (:45); ATS RTR and Offer stay single-signer (M-5 :30). Supersedes every one-signer clause.
  - `Aramo-Sign-Signup-Federated-Owner-Directive-v1_2` (2026-10-20) and its `Amendment-A1-Organization-Details-US-Only-v1_0` (2026-10-21) — federated owner signup; organization details 50 states + DC only (:21); US-only applies to all self-service Sign subscriptions (:24). A1 replaces parent §3 R2/R3, §4, §5.
  - `Aramo-Sign-Personal-Free-Launch-Directive-v1_1` (2026-10-21) — Free Personal: 5 envelopes per monthly period, at most 2 per day (:32); 15 MiB, one user (:33); modes `off` → `invite` → `open`, ships `off` (:39). Its `Amendment-A1-v1_0` (LOCKED 2026-10-22) takes precedence: IP geolocation a risk signal only (A1-1 :23), operator review instead of SMS step-up (A1-2 :24), three legal documents APPROVED v1.0 (A1-4 :26), daily cap rolling 24 hours (A1-7 :29), self-service account close and in-app legal re-acceptance (A1-10 :32).
  - `Aramo-Subdomain-Identity-B-IdP-Routing-Directive-Amendment-A2-Enforced-Provider-Pin-Sign-Signup-Cohort-v1_0` (2026-10-20) — enforced provider pin for the Sign self-signup cohort.
  - `Aramo-ROLES-1-Organization-and-Product-Role-Model-Implementation-Directive-v1_0` + Conforming Amendments (2026-10-21) — `sign_owner` retired (:24); `tenant_owner` receives its Sign scopes (:59) and holds billing; Sign product roles stay `sign_admin`, `sign_sender`, `sign_viewer`.
- **Template sources ratified after 2026-10-09:**
  - `Aramo-DOC-TEMPLATE-ADMIN-RTR-1-Tenant-Document-Template-Administration-RTR-Governed-Template-v1_0` (canonical filing 2026-10-16; no ratification date inside the file) with Amendment A1 (allowlisted HTML `rtr-html-v1`, LOCKED 2026-10-16) and Amendment A2 (desired pay rate binding, LOCKED 2026-10-16). Partly superseded by DOC-TEMPLATE-LIB-1 Conforming Amendments.
  - `Aramo-DOC-TEMPLATE-LIB-1-Shared-Document-Template-Library-Implementation-Directive-v1_0` + `-Conforming-Amendments-v1_0` (LOCKED 2026-10-21) — slices T-1 to T-6 (:148–:153); PLATFORM scopes; `sign:template:*` removed; Sign consumes templates over the signed s2s channel. Its PLATFORM-default resolver fallback is superseded by ORG-UX-1.
  - `Aramo-ORG-UX-1-App-Home-and-Organization-Redesign-Implementation-Directive-v1_0` + Conforming Amendments (LOCKED 2026-10-21) — `document_template:author` (NEW, :100); adopt endpoint creates a full independent copy (:190–:191) with provenance-only `adopted_from_*` (:193); lifecycle adopt → draft → edit → approve → active, approval by tenant_admin/tenant_owner (:49–:50); the resolver drops "no selection → PLATFORM default" and returns `SELECTION_REQUIRED` (:211).
  - `Aramo-Pipeline-RTR-Recon-Remediation-Directive-v1_0` (LOCKED 2026-10-21) — R2 / DEF-12 (:68): Sign publishes declined / voided / expired; new `DECLINED` Document status; ATS handling idempotent and never overwrites EXECUTED.
- **Repo record (not ratified intent):** `doc/directives/Aramo-E-Sign-Multi-Provider-Addendum-A1-Precedence-and-Traceability-v1_0.md` is a program record (:7, "changes no LOCKED original"); its inferred precedence rows await Lead confirmation, so it is not cited as intent.
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
- **ATS-neutral E-Sign (DOC-3 schema header; §10 R7):** the Sign schema references
  Documents only by opaque UUID — no cross-schema FK, no ATS import.
- **Naming (Naming Unification directive, LOCKED 2026-10-20):** the application,
  schema, API prefix and auth consumer are `sign` (`apps/sign-service`, schema
  `sign`, `/v1/sign/*`); the parent directive's `apps/esign-service` / `esign`
  names are superseded on identifiers only.
- **Standalone product (Unified Product directive §1; S6 Addendum):** Aramo Sign is
  a standalone product and the ATS is a client of it; the ATS migrates onto the
  authenticated Sign API (S-6), with the internal zone "closed after validated
  migration" (Unified Product :147) and the internal transport kept as fallback
  until then (S6 :34).
- **One host (Addendum D-1 :16):** `sign.aramo.ai` serves guest signing, public
  entry and the signed-in workspace (three zones, Unified Product S-2 :143);
  `esign.aramo.ai` is retired with no redirect.
- **Commercial and routing separation (Multi-Provider directive):** plan /
  allowance authority, provider routing and the signing engine stay separate; a
  refusal never waives a required RTR (:113); the provider is frozen per request
  (:122).

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

- **Template library (ADR-0034; DOC-TEMPLATE-LIB-1; ORG-UX-1):** one library in
  `libs/documents` with PLATFORM and TENANT owners (ADR-0034 D1); a tenant uses an
  Aramo default by ADOPTING it into an independent TENANT copy with provenance-only
  fields (ORG-UX-1 :190–:193), which overrides ADR-0034 D4/D5; resolution is
  client → tenant selection and returns `SELECTION_REQUIRED` with no usable
  selection (ORG-UX-1 :211), which overrides DOC-TEMPLATE-LIB-1 §4.2's PLATFORM
  fallback; grandfathered legacy PLATFORM selections are kept (ORG-UX-1 §5.3);
  withdrawal with notice and fallback (ADR-0034 D10).
- **Document status DECLINED (Pipeline-RTR Remediation R2 / DEF-12 :68):** additive
  status; ATS recording of declined / voided / expired is idempotent and never
  overwrites EXECUTED.

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
- Lifecycle integrity (ES-1 :36): terminal states irreversible; no signer action
  after void / decline / expiry / completion; concurrent transitions safe.
- Multi-signer (Multi-Signer Amendment): up to 10 signers (M-2 :25), PARALLEL or
  SEQUENTIAL routing with PARALLEL default (:45), sequential order enforced by the
  engine; ATS RTR and Offer remain single-signer (M-5 :30). Supersedes the PX-V1,
  Standalone and ES-1 one-signer clauses.
- Personal (Free) sending (Personal Free v1.1 + A1): 5 envelopes per monthly
  period and at most 2 per rolling 24 hours (v1.1 :32; A1-7 :29); risk gate with IP
  location as a signal only (A1-1 :23); abuse reports; self-service close and
  in-app legal re-acceptance (A1-10 :32); modes `off` → `invite` → `open`, shipping
  `off` (v1.1 :39).
- Allowance (Multi-Provider §B/§C; Commercial A1): metered per accepted send,
  concurrency-safe at the limit; Business plans have no fixed envelope ceiling
  (Commercial A1 :14–:15); Professional requires an ATS subscription (:44; D16).

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
PX-V1 product scopes are ratified by the PX-V1 LOCKED directive (PX-3), as a
dedicated Sign product namespace distinct from the ATS `document:*` scopes; the
Naming Unification directive renames them `sign:*`, the Unified Product directive
§4.3.4 sets the Sign role catalog, and ROLES-1 retires `sign_owner` (billing to
`tenant_owner`). Template authority: DOC-TEMPLATE-LIB-1 §6 adds
`platform:document_template:{read,manage}` and removes `sign:template:*`; ORG-UX-1
§4.1 adds `document_template:author` and narrows `document_template:manage` to
approve / select / withdraw.

## Build sequence intent (§20 R24, line 357)

DOC-3 = Native E-Sign Service Core (`apps/esign-service`, `esign` schema (now `apps/sign-service`, schema `sign`),
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

Aramo Sign product sequence (Unified Product directive §5 :142–:148): S-1
permission contract and roles; S-2 one app on one host; S-3 ATS envelopes in the
workspace; S-4 applications, installations, credentials; S-5 per-installation
webhooks; S-6 ATS on the Sign API; S-7 recipient inbox. Template library
sequence (DOC-TEMPLATE-LIB-1 §11 :148–:153): T-1 database foundation … T-6
withdrawal and tags. Activation items not authorized by these directives include
switching production ATS transport to `api` (S6 :38), public third-party API
exposure, live billing, public signup and Personal mode beyond `off`.

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
- `DOC-TEMPLATE-ADMIN-RTR-1` carries no ratification date in its text; its
  canonical filing date (2026-10-16) comes from a provenance record in
  `Aramo/documents/`, not from the directive.
- The repo `doc/directives/Aramo-E-Sign-Multi-Provider-Addendum-A1-Precedence-and-Traceability-v1_0.md`
  is a program record awaiting Lead confirmation of its inferred precedence rows;
  not ratified intent.
- Unratified items in `Aramo/documents/` (not cited as intent):
  `Aramo-Sign-Personal-Terms-of-Service-v0_2-DRAFT.md` (replaced by the approved
  v1.0 per Personal A1-4), `Aramo-Sign-Signup-Federated-Owner-Directive-v1_1-RECONCILED-HELD.md`
  (superseded by v1.2), `Aramo-Sign-Unified-Product-Amendment-A1-Retire-esign-Host-v1_0-DRAFT.md`
  (withdrawn by the S6 and D-1 addenda). The other DRAFTs modified after
  2026-10-09 in that folder each have a LOCKED successor listed above.
- Signup A1 (:15) records Domain-Enforcement P3 as not ratified there; P3 has its
  own LOCKED directive (`Aramo-Domain-Enforcement-P3-One-Organization-Per-Domain-Directive-v1_0-LOCKED.md`,
  2026-10-21), outside D10.
