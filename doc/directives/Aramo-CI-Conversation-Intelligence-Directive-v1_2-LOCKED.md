# ARAMO — Conversation Intelligence Directive v1.2 — LOCKED

Status: LOCKED / ACTIVE

Authority:
Product Owner + Lead Architect

Supersedes:
- Aramo-CI-Conversation-Intelligence-Directive-v1_1-LOCKED.md
- Aramo-CI-Directive-v1_0-LOCKED.md

Supersession reason:
v1.1 was abandoned before ratification and removed from the canonical store after vocabulary-governance defects were identified. No implementation authority was exercised under v1.1.

Accepted baseline authority:
CI-A0 Recon Report
origin/main = dbce8742ffc2849a6cfa3381a1626471795003bb

Implementation posture:
BUILD-START AUTHORIZED under this directive after canonical filing and SHA-256 verification.

Commit / PR authority:
NOT granted by this directive unless a seam-specific Gate-6 publication authorization is issued.

Merge authority:
NOT GRANTED.

Deploy authority:
NOT GRANTED.

Production-provider enablement:
NOT GRANTED.

Production recording / transcription / AI-processing activation:
NOT GRANTED.

---

# 0. PURPOSE

Aramo Conversation Intelligence provides evidence-grounded, human-reviewed recruiter assistance from provider-generated conversation transcripts.

The capability is intended to reduce recruiter administrative work after conversations while preserving:

- human recruiting judgment;
- provider-neutral communications architecture;
- consent and lawful-use boundaries;
- tenant isolation;
- evidence provenance;
- retention and deletion controls;
- existing Recruiting domain authority.

The canonical product outcome is:

provider conversation
→ provider-generated full transcript
→ asynchronous Aramo transcript ingestion
→ provider-neutral normalization
→ exact Requisition grounding
→ AI-generated evidence-backed claims
→ recruiter review
→ approved recruiting note/findings

Conversation Intelligence is NOT a hiring-decision authority.

---

# 1. ACCEPTED GROUNDING

The CI-A0 repository/provider recon at:

dbce8742ffc2849a6cfa3381a1626471795003bb

is accepted as the baseline substrate grounding.

A new full recon is NOT required before implementation.

Before each implementation seam:

1. fetch current origin/main;
2. record exact SHA;
3. perform a seam-local drift check against the accepted baseline;
4. inspect only the modules/contracts relevant to that seam;
5. HALT only when intervening changes invalidate a LOCKED architectural premise.

Minor unrelated drift does not stop CI.

Material drift includes, for example:

- CommunicationInteraction ownership changed;
- CommunicationProviderEvent semantics changed;
- consent authority materially changed;
- object-storage architecture changed;
- AI infrastructure ownership changed;
- Requisition gained a new authoritative immutable content-version suitable for CI grounding;
- provider integration architecture changed incompatibly;
- another active track owns a required shared file in a manner that cannot safely be isolated.

---

# 2. CORE ARCHITECTURE

## 2.1 Provider owns media

For CI V1, external communication providers own:

- telephony/media transport;
- participant media capture;
- speech-to-text generation where supported;
- provider transcript production;
- provider transcript availability signaling.

Aramo does NOT implement a primary speech-recognition engine when a suitable provider-generated transcript is available.

Aramo V1 does NOT place itself in the raw RTP/media path.

---

## 2.2 Aramo owns recruiting intelligence

Aramo owns:

- transcript acquisition orchestration;
- normalized transcript contract;
- exact Talent/Requisition binding;
- Requisition analysis-context snapshot;
- recruiting-specific structured extraction;
- transcript-span provenance;
- AI draft lifecycle;
- recruiter review;
- approved conversation notes/findings;
- audit and retention metadata.

Transcription is infrastructure.

Requisition-grounded recruiting intelligence is the Aramo product layer.

---

## 2.3 Full transcript is the intelligence substrate

The canonical CI input is:

FULL PROVIDER-GENERATED TRANSCRIPT

where available.

Provider-generated summaries such as:

- Zoom AI Call Summary;
- Teams AI insights;
- provider-generated recap;
- provider-generated action list;

MUST NOT substitute for the full transcript when Aramo performs evidence-grounded Conversation Intelligence.

Provider summaries are not CI evidence authority.

CI V1 MUST use transcript text with evidence-grade references when performing Requisition-grounded extraction.

---

# 3. DOMAIN OWNERSHIP

## 3.1 Communications

`libs/communications` remains authoritative for:

- CommunicationInteraction;
- provider event inbox;
- provider identity/correlation;
- call/meeting execution evidence;
- communication associations;
- provider event provenance;
- provider-specific acquisition adapters;
- provider transcript availability normalization.

Communications answers:

"Did this communication occur, through which provider, and how is it correlated?"

Communications does NOT own recruiting interpretation.

---

## 3.2 Consent

`libs/consent` remains the sole consent/policy authority.

Conversation Intelligence MUST NOT create:

- a parallel consent database;
- a CI-specific consent authority;
- a duplicate consent policy engine.

Existing consent architecture SHALL be extended only where required.

---

## 3.3 Conversation Transcript

A dedicated provider-neutral transcript context is authorized.

Recommended logical name:

`conversation-transcript`

It owns:

- transcript resource metadata;
- provider transcript reference;
- source artifact reference;
- normalized artifact reference;
- integrity hashes;
- acquisition lifecycle;
- normalization lifecycle;
- source type;
- language;
- speaker-attribution metadata;
- timestamp availability metadata;
- retention classification;
- expiry/deletion state;
- interaction reference.

It does NOT own CommunicationInteraction.

---

## 3.4 Conversation Intelligence

A dedicated bounded context is authorized.

Recommended logical name:

`conversation-intelligence`

It owns:

- immutable Requisition analysis-context snapshot;
- CI analysis run;
- model identifier;
- prompt version;
- output schema version;
- transcript version/hash binding;
- AI-generated claims;
- evidence citations;
- AI draft;
- recruiter review state;
- recruiter-approved findings;
- approved note linkage;
- CI provenance.

---

## 3.5 Recruiting

Recruiting/Pipeline remains authoritative for:

- qualification;
- rejection;
- submission;
- journey state;
- placement;
- offer;
- other governed Talent lifecycle actions.

CI MUST NOT silently perform those actions.

---

## 3.6 Engagement Policy

Engagement Policy remains separate.

Existing voice evidence answers:

"Did qualifying communication occur?"

Conversation Intelligence answers:

"What recruiting-relevant information was communicated?"

Generating AI notes MUST NOT itself satisfy a voice-evidence requirement.

---

# 4. CONSENT / NOTICE MODEL

## 4.1 Independent governed operations

The following are separate operations:

- contacting;
- recording;
- transcription;
- AI processing.

They MUST NOT be collapsed into one blanket permission.

Critically:

RECORDING IS NOT A PREREQUISITE FOR TRANSCRIPTION.

A valid provider path may be:

contacting = ALLOWED
recording = PROHIBITED
transcription = ALLOWED
AI processing = ALLOWED

if the communication provider supports transcription without recording.

Every operation actually performed must independently satisfy the applicable Tenant policy.

---

## 4.2 Authorization relationships

The system MUST NOT infer:

contact permission
→ recording permission

or:

contact permission
→ transcription permission

or:

transcription permission
→ AI-processing permission

or:

AI-processing permission
→ recording permission

Every required authority is independently evaluated.

---

## 4.3 Recording-specific rule

If recording is actually used:

recording authority MUST be proven.

If the provider can provide an eligible full transcript without recording:

recording authority is NOT required solely because transcription is used.

---

## 4.4 Notice / affirmative consent

The consent authority must be capable of representing, as appropriate:

- Tenant-policy permission;
- notice required;
- affirmative consent required;
- prohibited;
- versioned notice;
- notice/consent evidence;
- communication reference;
- occurred-at;
- actor/source.

Provider capability is never equivalent to participant consent.

Provider-generated prompts may constitute evidence only where the governing policy recognizes that method.

---

## 4.5 Fail-closed processing

If the required transcription authorization is not proven:

do not acquire transcript.

If AI-processing authorization is not proven:

do not invoke Conversation Intelligence.

The underlying phone call may still proceed if contacting itself is permitted.

CI failure must never invalidate valid Communications evidence.

---

# 5. TRANSCRIPT PROVIDER CONTRACT

Conversation Intelligence MUST be provider-neutral.

The domain boundary SHALL NOT be:

ZoomTranscriptService
→ Aramo Notes

The architecture SHALL provide a provider-neutral transcript acquisition contract.

Conceptually:

ConversationTranscriptProvider

with declared capabilities such as:

- full post-conversation transcript;
- live transcript stream;
- speaker attribution;
- timestamps;
- confidence values;
- transcript language;
- custom vocabulary;
- provider-side redaction;
- recording dependency;
- provider transcript retention;
- provider event support.

Provider-specific field names terminate at adapter boundaries.

---

# 6. PROVIDER STRATEGY

## 6.1 Target V1 recruiter-call provider

Zoom Phone is the TARGET V1 recruiter-call provider.

This reflects the intended Aramo Tenant voice use case.

However, Zoom implementation is conditioned on provider validation.

---

## 6.2 Zoom prerequisite validation

Before implementing the Zoom transcript adapter, engineering MUST verify from official Zoom documentation and/or an authorized live Tenant:

1. whether a full transcript is retrievable through a supported API;
2. whether that transcript requires cloud recording;
3. source artifact/file format;
4. speaker-attribution structure;
5. timestamp structure;
6. exact OAuth scopes;
7. transcript-availability event/webhook behavior;
8. transcript lifecycle and retention;
9. what happens when audio is deleted;
10. whether transcript and recording retention are independently controllable.

Required verdict:

ZOOM_PHONE_FULL_TRANSCRIPT_WITHOUT_CLOUD_RECORDING =
SUPPORTED | NOT_SUPPORTED | NOT_PROVEN

No implementation may assume SUPPORTED without proof.

---

## 6.3 Teams

Microsoft Teams is an independently supported provider path.

Teams MAY be used as the first executable provider proof when:

- provider-neutral substrate is ready;
- Graph transcript access is technically available;
- Zoom validation remains unresolved.

This does NOT redefine Teams as the primary CI product provider.

---

## 6.4 Provider implementation order

Canonical ordering:

1. provider-neutral substrate;
2. transcript lifecycle/normalization;
3. provider adapters according to readiness;
4. Aramo CI processing;
5. recruiter review;
6. approved-output integration.

Provider implementation order is not a business-domain ownership rule.

---

# 7. TRANSCRIPT RESOURCE / CUSTODY MODEL

## 7.1 Postgres

Postgres MAY persist:

- transcript metadata;
- provider transcript ID;
- interaction ID;
- source object reference;
- normalized object reference;
- hashes;
- state;
- retention metadata;
- timestamps;
- schema versions.

Postgres MUST NOT persist:

- complete raw transcript body;
- complete normalized transcript body;
- provider transcript payload in generic JSON columns.

---

## 7.2 Object storage

Transcript bodies belong in encrypted object storage.

Source transcript:
encrypted object storage

Normalized transcript:
encrypted object storage

Requirements:

- tenant-scoped object identity;
- encryption at rest;
- CMK/SSE-KMS where current platform substrate supports it;
- no public objects;
- short-lived access;
- access auditing;
- integrity hash;
- deletion/expiry support.

---

## 7.3 Custody modes

Architecture SHALL permit the concept of:

PROVIDER_REFERENCED
TEMPORARILY_CACHED
ARAMO_RETAINED

The presence of transcript metadata does NOT require permanent Aramo transcript-content custody.

---

# 8. RETENTION

Audio, transcript, and approved notes are independent retention classes.

## 8.1 Audio

Aramo raw-audio retention default:

OFF.

Provider recording retention remains provider/Tenant governed.

---

## 8.2 Transcript

Transcript retention is Tenant-policy governed.

No indefinite default retention is authorized.

Source and normalized transcript artifacts may be:

- short-lived;
- deleted after recruiter review;
- retained for a configured period;
- retained under legal hold where applicable.

Metadata/provenance MAY survive artifact deletion where governance requires it.

---

## 8.3 Approved notes

Recruiter-approved notes/findings follow the applicable recruiting-record retention policy.

---

# 9. NORMALIZED TRANSCRIPT CONTRACT

The canonical normalized transcript must support evidence-grade references.

Minimum logical shape:

- transcript artifact ID;
- tenant ID;
- interaction ID;
- provider key;
- provider transcript ID;
- source artifact ref;
- normalized artifact ref;
- source SHA-256;
- normalized SHA-256;
- language;
- schema version;
- generated/captured timestamps;
- ordered utterances;
- stable utterance IDs;
- speaker role/label where supported;
- provider speaker ID where relevant;
- start timestamp where supported;
- end timestamp where supported;
- utterance text.

Possible speaker roles:

- RECRUITER;
- TALENT;
- OTHER;
- UNKNOWN.

No adapter may fabricate:

- speaker identity;
- timestamps;
- missing turns;
- transcript content.

Unknown means unknown.

---

# 10. IMMUTABLE REQUISITION ANALYSIS CONTEXT

Every CI analysis must bind to immutable Requisition context.

The mutable current Requisition row MUST NOT serve as historical proof.

A dedicated snapshot is authorized.

Minimum properties:

- tenant ID;
- requisition ID;
- source row version/CAS where available;
- snapshot schema version;
- captured-at;
- title/role context;
- location;
- work arrangement;
- job/employment type;
- relevant work-authorization requirement;
- GoldenProfile context where relevant;
- job-relevant skills/experience/constraints available in the current model;
- only recruiter-authorized financial/compensation context where truly needed.

Do NOT invent domain fields that do not exist, including a required/preferred requirement split unless future substrate introduces one.

Snapshot is:

- immutable;
- not generally editable;
- not a generic Requisition-history system;
- tenant scoped.

---

# 11. CONVERSATION INTELLIGENCE INPUT

The CI processing input is conceptually:

Normalized transcript
+
Talent/Requisition association
+
immutable Requisition analysis snapshot
+
current permitted recruiting context
+
configured CI policy

Only necessary context should be sent to the model.

---

# 12. STRUCTURED OUTPUT

V1 output is deliberately constrained.

Allowed classes include:

- concise conversation summary;
- Talent-stated job-relevant claims;
- Requisition-related discussion findings;
- unanswered/unclear topics;
- Talent questions;
- recruiter commitments;
- Talent commitments;
- follow-up suggestions;
- proposed recruiter note.

---

# 13. CLAIMS, NOT AUTOMATIC FACTS

Before recruiter review, AI-produced statements are:

AI-GENERATED CLAIMS

not authoritative facts.

Example:

Preferred:

"Talent stated approximately eight years of Java experience."

Not:

"Talent has eight years of Java experience."

An AI claim may become a:

RECRUITER-APPROVED FINDING

only after explicit recruiter review.

Talent statements are evidence of what was said, not independent verification that the statement is objectively true.

---

# 14. REQUISITION-GROUNDED EVIDENCE

Every material claim must bind to:

finding/claim
→ transcript utterance/span
→ normalized transcript
→ CommunicationInteraction

and:

finding/claim
→ immutable Requisition analysis snapshot

A material claim without transcript evidence is invalid.

Conceptual status values may include:

- SUPPORTED_BY_STATEMENT;
- PARTIALLY_SUPPORTED;
- DISCUSSED_UNCLEAR;
- NOT_DISCUSSED;
- CONTRADICTED.

These describe conversation evidence, not final hiring judgment.

---

# 15. NO AUTHORITY EXPANSION

CI may NOT:

- score Talent;
- rank Talent;
- decide hire/no-hire;
- reject Talent;
- qualify Talent automatically;
- change Pipeline state;
- submit Talent;
- change Client Selection;
- create/change Offer;
- change Consent;
- merge identity;
- silently mutate TalentRecord;
- silently change work authorization;
- silently make AI content durable operational evidence;
- infer protected/sensitive characteristics for recruiting use.

Human/domain-authorized actions remain authoritative.

---

# 16. SAID VS DONE

Conversation evidence and execution evidence are separate.

Example:

Recruiter says:
"I will send the RTR email."

CI MAY create:

Recruiter commitment:
Send RTR email.

CI MUST NOT assert:

RTR_EMAIL_SENT = TRUE

without actual Communications email evidence.

Similarly:

Talent says:
"I can start in two weeks."

CI MAY capture:

Talent-stated availability:
two weeks.

CI MUST NOT silently change an authoritative placement/start-date record.

---

# 17. SENSITIVE-CONTENT MINIMIZATION

Conversation transcripts may contain information unrelated to legitimate recruiting purposes.

CI MUST use a constrained extraction schema.

The system should extract only explicitly allowed recruiting-relevant concepts.

It MUST NOT automatically promote incidental sensitive/protected information into Talent profile truth.

Where current AI/redaction infrastructure exists, reuse it.

No raw transcript content belongs in ordinary application logs, traces, telemetry, or error messages.

---

# 18. AI INFRASTRUCTURE

Conversation Intelligence consumes the existing Aramo AI infrastructure.

It does NOT create another general AI platform.

Reuse current model abstractions where suitable.

CI may add or extend:

- structured-output validation;
- prompt version;
- output schema version;
- model ID;
- token/cost telemetry;
- request/response hashes;
- retry/error handling;
- evaluation fixtures.

No raw model prompt/completion persistence unless separately governed.

---

# 19. ASYNCHRONOUS / EVENT-DRIVEN EXECUTION

Conversation Intelligence V1 MUST be asynchronous.

Do NOT implement the core path as:

call ends
→ synchronous browser/API request
→ transcript fetch
→ LLM
→ response

Canonical processing:

provider transcript-availability signal
→ provider event inbox
→ interaction correlation
→ transcript acquisition job
→ source artifact persist
→ normalization job
→ normalized artifact persist
→ Requisition analysis-context snapshot
→ CI processing job
→ schema validation
→ review-ready draft
→ recruiter review
→ approved output integration

Reuse existing platform mechanisms such as:

- CommunicationProviderEvent;
- BullMQ;
- Redis gating;
- persisted processing state;
- bounded retries;
- attempt counters;
- intervention/manual-park behavior;

where recon proves they are the existing substrate.

Do NOT falsely treat structured-log publishing as a real message bus.

---

# 20. PROCESSING STATE

Use the smallest necessary explicit lifecycle, conceptually:

WAITING_FOR_SOURCE
SOURCE_AVAILABLE
ACQUIRING
NORMALIZING
ANALYZING
REVIEW_READY
APPROVED
DISCARDED

Failure states may include:

FAILED_RETRYABLE
INTERVENTION_REQUIRED
FAILED_TERMINAL
EXPIRED

Exact enum names should follow repository conventions.

Every stage must be idempotent.

---

# 21. AI RUN PROVENANCE

Every CI run must retain immutable provenance sufficient to answer:

- which transcript?
- which transcript hash/version?
- which Requisition snapshot?
- which model?
- which prompt?
- which output schema?
- when?
- for which Tenant?
- what review followed?

Conceptual data includes:

- tenant ID;
- interaction ID;
- transcript ID;
- transcript hash;
- requisition snapshot ID;
- model ID;
- prompt version;
- output schema version;
- started-at;
- completed-at;
- status;
- input/output integrity hashes.

---

# 22. HUMAN REVIEW

AI output MUST enter a reviewable draft lifecycle.

Conceptual states:

PROCESSING
DRAFT_READY
UNDER_REVIEW
APPROVED
DISCARDED

Edit-and-approve is permitted.

The system must preserve:

- original AI draft;
- recruiter-approved final content;
- reviewer identity;
- review timestamp;
- review disposition;
- evidence links;
- CI run provenance.

No hidden or implicit auto-approval.

---

# 23. RECRUITER REVIEW UX

The review experience should surface:

- Communication context;
- Talent;
- Requisition;
- provider;
- call duration where available;
- consent/transcription status;
- AI-generated summary;
- Requisition-grounded claims;
- source evidence;
- speaker/timestamp where available;
- unanswered topics;
- follow-ups;
- limitations/uncertainties.

Actions:

- Approve;
- Edit and approve;
- Reject individual claim where supported;
- Discard draft.

Low-confidence/unclear claims must remain visible as needing review rather than silently becoming authoritative.

---

# 24. APPROVED OUTPUT

Do NOT create a second generic note platform.

Reuse existing Aramo operational primitives when semantics fit.

Recruiter-facing approved note may use:

- existing Activity;
- interaction-bound CommunicationDisposition notes;
- another established note primitive where recon confirms semantic fit.

Structured approved findings may reuse existing governed annotation/evidence patterns where appropriate.

A new CI-specific draft carrier is authorized because AI draft content is not yet operational truth.

---

# 25. TRANSCRIPT ACCESS VS NOTE ACCESS

Transcript access is more sensitive than approved-note access.

Dedicated capabilities must separate at least:

- transcript read;
- CI read;
- CI review;
- CI approve;
- CI admin/policy where needed.

Do NOT implicitly give raw transcript access to every user who can read approved recruiting notes.

Exact scope literals are seam-authorized implementation details subject to repository vocabulary/seed conventions.

---

# 26. FAILURE SEMANTICS

If transcript acquisition fails:

CommunicationInteraction remains valid.

If normalization fails:

do not produce false READY.

If CI processing fails:

do not invent notes.

If consent/authorization denies transcript use:

the call itself remains governed by Communications and may remain valid.

UI examples:

"AI notes unavailable"

not:

"Call failed"

and:

"Preparing AI notes..."

for delayed asynchronous processing.

---

# 27. IDEMPOTENCY

Provider events may retry.

Transcript acquisition must converge idempotently.

CI processing must not create duplicate drafts/approved notes due to:

- duplicate webhook;
- worker retry;
- page refresh;
- repeated provider event;
- queue replay.

Approval side effects must also be idempotent.

---

# 28. PRIVACY / SECURITY

Transcript artifacts are sensitive recruiting data.

Minimum controls:

- tenant isolation;
- encryption at rest;
- encryption in transit;
- no public object access;
- no frontend bucket enumeration;
- short-lived authorized access;
- access audit;
- retention classification;
- expiry/delete;
- DSAR/data inventory;
- erasure behavior;
- legal-hold compatibility where required;
- least-privilege provider OAuth;
- no provider secrets in Postgres/browser/logs;
- no transcript body in logs/traces.

---

# 29. VOCABULARY-GATE GOVERNANCE

The canonical CI directive necessarily names prohibited AI-authority concepts solely to define explicit refusal boundaries.

The directive itself MUST use canonical Aramo entity vocabulary.
A non-canonical entity synonym is NOT eligible for exemption merely because it appears inside this governance artifact.

Therefore CI-B0 is authorized to add an EXACT-FILE Tier-2 vocabulary exclusion for:

`Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED.md`

across the three enforcement surfaces that currently enforce the repository vocabulary discipline:

1. `scripts/verify-vocabulary.sh`
2. `eslint.config.mjs`
3. `.claude/hooks/vocab-guard.sh`

The exemption exists only so this LOCKED governance instrument can name prohibited AI-authority concepts when defining refusal boundaries.

Required rationale:

"This LOCKED governance artifact names prohibited AI-authority concepts solely to define refusal boundaries."

The exclusion MUST remain exact-file scoped.

It MUST NOT exempt:

- `doc/directives/**`;
- the canonical LOCKED directory generally;
- all Markdown files;
- future directives;
- production source;
- UI copy;
- API contracts;
- domain models.

The PostToolUse vocabulary hook SHALL continue to enforce canonical vocabulary for ordinary canonical-document writes.

For this directive only, the hook may recognize the exact filename above in both:

- the canonical LOCKED location; and
- the repository `doc/directives/` copy.

No other file receives the exemption.

The canonical directive and repository copy MUST be byte-for-byte identical.

Any non-refusal vocabulary violation discovered in the directive itself must be corrected in the canonical text rather than hidden by the exemption.

---

# 30. ARCHITECTURE_HALT CONDITIONS

Immediately HALT if implementation requires:

1. transcript body in Postgres;
2. provider secrets in Postgres/browser;
3. frontend direct provider transcript API calls;
4. raw telephony media capture by Aramo V1;
5. weakening existing raw-provider-payload rules;
6. new parallel consent authority;
7. autonomous Talent rejection;
8. autonomous qualification;
9. autonomous submission;
10. autonomous hiring decision;
11. autonomous identity merge;
12. autonomous Consent mutation;
13. AI draft becoming durable without human review;
14. material claims without transcript evidence;
15. mutable Requisition row used as historical analysis proof;
16. fabricated speaker attribution/timestamps;
17. provider-specific transcript types leaking across the provider boundary;
18. cross-tenant transcript visibility;
19. provider summary substituting for full transcript in evidence-grounded CI;
20. assuming Zoom transcript-without-recording support without proof;
21. score/rank semantics entering V1;
22. shared-file collision that cannot safely be isolated;
23. implementation requiring a real message-bus architecture that does not exist and was not separately authorized.

---

# 31. DELIVERY SEAMS

The program is divided into bounded seams.

Each seam should normally be one PR.

## CI-B0 — Governance Ratification

Goal:

Land governance artifacts and make the directive discoverable/enforceable.

Deliverables:

- this v1.2 LOCKED directive, verbatim;
- exact-file vocabulary exclusion in all three guard implementations;
- CI architecture ADR;
- CI-A0 accepted baseline;
- Architecture HALT list;
- provider strategy;
- directive checksum/reference as required;
- ADR index update.

Production source behavior changes:

NONE.

---

## CI-B1 — Consent / Notice Extension

Goal:

Extend the existing Consent authority to independently govern:

- recording;
- transcription;
- AI processing.

Hard rule:

recording is not prerequisite for transcription.

Required negative tests include:

contact allowed + transcription denied
→ no transcript acquisition

recording prohibited + transcription allowed + AI allowed
→ eligible if provider transcript requires no recording

transcription allowed + AI denied
→ transcript may exist according to policy, but no CI processing

missing required affirmative consent
→ fail closed

No parallel consent authority.

---

## CI-B2 — Immutable Requisition Analysis Context

Goal:

Create immutable CI-specific Requisition context snapshot.

No general update route.

No generic Requisition-versioning redesign.

Prove:

later Requisition edits do not mutate historical CI interpretation context.

---

## CI-B3 — Transcript Metadata + Provider-Neutral Acquisition Contract

Goal:

Establish:

- transcript metadata aggregate;
- provider-neutral provider port;
- source/normalized refs;
- hashes;
- state machine;
- interaction linkage;
- retention metadata;
- idempotency.

No provider-specific implementation yet unless minimal fixtures are needed.

No transcript body in Postgres.

---

## CI-B4 — Canonical Normalization + Artifact Lifecycle

Goal:

Create provider-neutral canonical transcript.

Deliver:

- canonical schema;
- stable utterance IDs;
- timestamp handling;
- speaker handling;
- source/normalized hashes;
- object-storage lifecycle;
- retention/expiry;
- deterministic fixture tests.

Downstream CI must consume only canonical normalized transcript.

---

## CI-B5Z — Zoom Phone Transcript Adapter

Entry condition:

Required Zoom provider validation completed.

Goal:

Attach Zoom Phone to the provider-neutral transcript contract.

Before implementation return the exact verdict:

ZOOM_PHONE_FULL_TRANSCRIPT_WITHOUT_CLOUD_RECORDING =
SUPPORTED | NOT_SUPPORTED | NOT_PROVEN

If NOT_PROVEN:
HALT B5Z without inventing a path.

If NOT_SUPPORTED:
return to Architect for disposition before assuming recording.

If SUPPORTED:
implement the proven no-recording transcript path.

No Zoom AI Call Summary input.

---

## CI-B5M — Microsoft Teams Transcript Adapter

This is an independent provider seam.

It MAY be implemented before B5Z if:

- B3/B4 are stable;
- Teams transcript access is proven;
- Zoom validation remains blocked.

It must feed exactly the same provider-neutral canonical transcript contract.

No downstream CI provider special cases.

---

## CI-B6 — Conversation Intelligence Processing

Goal:

Produce structured, evidence-grounded AI claims.

Deliver:

- CI run aggregate;
- model/prompt/schema versioning;
- structured validator;
- Requisition snapshot binding;
- transcript binding;
- evidence citations;
- AI draft carrier;
- retry/park semantics;
- AI audit integration.

No score/rank.

No autonomous lifecycle action.

---

## CI-B7 — Recruiter Review

Goal:

Explicit human review.

Deliver:

- review queue/read;
- evidence detail;
- approve;
- edit-and-approve;
- discard;
- reviewer identity/time;
- immutable history;
- RBAC;
- no auto-approval.

---

## CI-B8 — Approved Output Integration

Goal:

Write recruiter-approved output into existing governed Aramo primitives where semantics fit.

Requirements:

- idempotent;
- no duplicate writes;
- discard writes nothing operational;
- original CI provenance remains reachable;
- no direct mutation of Talent truth without existing domain-authorized review path.

---

## CI-B9 — Provider Expansion / Live-CI Readiness

Goal:

Extend provider-neutral architecture for additional providers and prepare live-stream capability.

This seam does NOT automatically authorize live recruiter coaching.

Live CI remains separately governed.

---

## CI-B10 — GA Hardening

Includes:

- AI evaluation corpus;
- unsupported-claim measurement;
- sensitive-data leakage tests;
- regression harness;
- replay;
- queue failure injection;
- provider outage handling;
- large transcript limits;
- retention deletion proof;
- DSAR;
- legal hold;
- credential rotation;
- cost/token telemetry;
- performance/load;
- runbook;
- UAT;
- security review;
- controlled live-provider validation.

---

# 32. PROGRAM GATES

Each seam follows:

Recon/drift check
→ implementation
→ verification
→ Gate-5
→ separate Gate-6 publication authority
→ CI/PR verification
→ separate exact-head merge authority
→ separate deployment authority

MERGED != DEPLOYED.

No seam self-authorizes merge.

---

# 33. GATE-5 STANDARD

A seam reaches Gate-5 only when:

- authorized implementation complete;
- targeted tests green;
- required repository gates green;
- no known directive violation;
- FIX_NOW = EMPTY;
- exact diff reported.

Incomplete authorized implementation is not CARRY.

Environmental verification blockers may be surfaced separately for Architect ruling.

---

# 34. CI V1 DEFINITION OF DONE

CI V1 is complete when an authorized provider conversation can:

1. correlate to a tenant-scoped CommunicationInteraction;
2. prove applicable consent/policy;
3. receive transcript availability idempotently;
4. retrieve the full provider transcript;
5. preserve provider credentials;
6. store/reference transcript according to retention policy;
7. normalize provider content deterministically;
8. create immutable Requisition analysis context;
9. execute CI asynchronously;
10. produce evidence-backed AI claims;
11. point each material claim to transcript evidence;
12. present recruiter review;
13. support approve/edit/discard;
14. persist only recruiter-approved operational output;
15. preserve original AI provenance;
16. enforce RBAC;
17. enforce tenant isolation;
18. enforce retention/deletion;
19. pass provider live validation;
20. pass AI evaluation;
21. remain free of score/rank/autonomous hiring authority.

---

# 35. FINAL GOVERNANCE STATE

CI-A0 recon:
ACCEPTED

CI architecture:
LOCKED

Full repo re-recon:
NOT REQUIRED

Seam-local drift check:
REQUIRED

Build start:
AUTHORIZED after canonical directive filing + hash verification

Commit:
SEPARATE GATE-6 AUTHORIZATION REQUIRED

Push:
SEPARATE GATE-6 AUTHORIZATION REQUIRED

PR:
SEPARATE GATE-6 AUTHORIZATION REQUIRED

Merge:
NOT AUTHORIZED BY THIS DIRECTIVE

Deploy:
NOT AUTHORIZED BY THIS DIRECTIVE

Production CI enablement:
NOT AUTHORIZED BY THIS DIRECTIVE

Production recording:
NOT AUTHORIZED BY THIS DIRECTIVE

End of Directive
