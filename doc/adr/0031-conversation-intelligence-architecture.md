# ADR-0031: Conversation Intelligence Architecture

**Status:** Accepted — LOCKED (records `Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED`)
**Date:** 2026-09-07

## Context

Aramo will produce evidence-grounded, human-reviewed recruiter assistance from
provider-generated conversation transcripts (voice calls, meetings). The
capability — Conversation Intelligence (CI) — is governed by the LOCKED
directive `Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED.md`
(canonical: OneDrive `Aramo/locked`; repository copy:
`doc/directives/Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED.md`,
byte-for-byte identical per directive §29).

This ADR records the durable architecture decisions from that directive so the
rationale survives instance turnover, per `doc/adr/README.md`. It does not
restate the directive; the directive is authoritative. Where a section number
appears below it refers to the directive.

**Accepted baseline (CI-A0).** The architecture is grounded on the CI-A0
recon at `origin/main = dbce8742ffc2849a6cfa3381a1626471795003bb`. A full
re-recon before build is NOT required; each seam performs a seam-local drift
check only (§1). The CI-A0 recon established: `libs/communications` owns the
`CommunicationInteraction` system-of-record + idempotent provider-event inbox
under the raw-payload-by-reference rule; `libs/consent` is the sole consent
authority (no recording/transcription/AI-processing scope exists yet);
`libs/object-storage` provides encrypted (CMK/SSE-KMS), tenant-scoped,
lifecycle-retained artifact storage by reference; `libs/ai-draft` is the sole
LLM substrate (single-vendor, draft-assist only, walled out of deterministic
domains); Requisition has NO immutable content-version suitable for grounding.

**Directive ratification.** `Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED.md`
SHA-256 `5bf31d1d7d6bbbcb0ee44aa05d6f80dca701faea01d95ff7f1b39433f00b75d7`
(supersedes CI-A0 directive v1.0; the pre-ratification v1.1 draft was abandoned
and removed from the canonical store — it is not a governed artifact).

## Decision

### Ownership map

| Responsibility | Owner | Reuse / Extend / New |
|---|---|---|
| Communication system-of-record, provider event inbox, provider correlation, provider transcript-availability normalization, provider transcript acquisition adapters | `libs/communications` (§3.1) | Reuse + extend |
| Consent / lawful-use policy (recording, transcription, AI-processing as independent operations) | `libs/consent` — sole authority; no parallel consent store (§3.2, §4) | Extend only |
| Provider-neutral transcript metadata, acquisition + normalization lifecycle, source/normalized artifact references, integrity hashes, retention classification | new bounded context `conversation-transcript` (§3.3) | New |
| CI analysis run, immutable Requisition analysis-context snapshot, model/prompt/output-schema versioning, AI-generated claims, transcript-span citations, AI draft carrier, recruiter-review lifecycle, CI provenance | new bounded context `conversation-intelligence` (§3.4) | New |
| LLM abstraction, vendor adapter, secret custody, redaction, request/response audit hashes, token usage | `libs/ai-draft` — infrastructure, not CI authority; CI may extend with structured-output validation + prompt/output-schema versioning; no weakening of no-LLM guards in deterministic domains (§3.4-consumer, §18) | Reuse + extend |
| Transcript bodies at rest (encrypted, tenant-scoped, by reference) | `libs/object-storage` pattern; Postgres holds metadata + opaque references only (§7) | Reuse |
| Async orchestration (provider event → correlation → acquisition → normalization → snapshot → CI processing → review-ready) | `CommunicationProviderEvent` idempotent inbox + BullMQ + Redis gating + row-level attempt counters; NO real message-bus dispatch assumed (§19) | Reuse |
| Immutable Requisition analysis-context snapshot | owned by `conversation-intelligence`; the mutable Requisition row is never historical proof (§3.6, §10) | New |
| Recruiter-approved output | reuse existing primitives — `activity.Activity`, interaction-bound `CommunicationDisposition.notes`, established evidence/annotation patterns; a new CI draft-content carrier is authorized because none exists (§24) | Reuse + one new carrier |
| Recruiting/Pipeline lifecycle (qualification, submission, selection, offer, placement) | Recruiting/Pipeline — CI never silently performs these (§3.5, §15) | Unchanged |
| Engagement Policy (voice-evidence requirement) | Engagement Policy — separate; generating AI notes never satisfies a voice-evidence requirement (§3.6) | Unchanged |

### Provider strategy (§6, §11)

- Architecture is provider-neutral; provider-specific types terminate at adapter
  boundaries (§5).
- **Zoom Phone is the TARGET V1 recruiter-call provider** (§6.1), conditioned on
  provider validation (§6.2). The Zoom adapter seam (CI-B5Z) must first return
  the verdict `ZOOM_PHONE_FULL_TRANSCRIPT_WITHOUT_CLOUD_RECORDING =
  SUPPORTED | NOT_SUPPORTED | NOT_PROVEN`; NOT_PROVEN → HALT, NOT_SUPPORTED →
  return to Architect before assuming recording. **CI-A0 recorded this verdict as
  NOT_SUPPORTED / NOT_PROVEN from official docs** (post-call transcript is a
  transcription of the cloud recording), so CI-B5Z is gated on live-tenant
  re-validation.
- **Microsoft Teams is an independently supported path** and MAY serve as the
  first executable provider proof (CI-B5M) while Zoom validation is unresolved
  (§6.3); CI-A0 established Teams transcript access is recording-independent.
  This does not redefine Teams as the primary product provider.
- No provider-generated summary (e.g. vendor AI call summaries) may substitute
  for the full transcript in evidence-grounded CI (§2.3, §7.2-directive).

### ARCHITECTURE_HALT conditions

Implementation halts and returns to Architect on any condition in directive §30
(23 conditions), including: transcript body in Postgres; provider secrets in
Postgres/browser; frontend direct provider-transcript API calls; raw telephony
media capture; weakening the raw-provider-payload rule; a parallel consent
authority; any autonomous Talent rejection / qualification / submission / hiring
decision / identity merge / consent mutation; AI draft becoming durable without
human review; material claims without transcript-span evidence; a mutable
Requisition row used as historical proof; fabricated speaker/timestamps;
provider-specific transcript semantics crossing the provider-neutral boundary;
cross-tenant transcript visibility; a provider summary substituting for the full
transcript; assuming Zoom transcript-without-recording without proof; score/rank
semantics; an unsafe shared-file collision; or assuming a real message-bus that
does not exist. The full authoritative list is directive §30 — this ADR points
to it and does not duplicate it.

### Build authority

Per directive §35: build-start is AUTHORIZED (canonical filing + SHA-256
verification complete). Commit / push / PR each require a SEPARATE Gate-6
publication authorization. Merge and deploy are NOT authorized by the directive.
Production recording / transcription / AI-processing activation is NOT
authorized. Seams CI-B0 through CI-B8 may proceed in dependency order; CI-B5Z
(Zoom) is conditionally authorized pending live-provider validation; CI-B10 (GA
hardening) follows once ≥1 provider path has live validation.

## Consequences

**Positive.** Provider-neutral, evidence-grounded, human-in-the-loop
architecture that reuses proven substrate (communications SoR + inbox, object
storage, ai-draft, consent) and confines new build to two well-bounded contexts.
Every material AI claim is traceable to a transcript span and an immutable
Requisition snapshot; no autonomous high-impact authority is introduced.

**Negative / cost.** Two new bounded contexts, a new immutable Requisition
analysis-context snapshot (Requisition has no reusable immutable content-version
today), consent-model extension (recording/transcription/AI-processing as
independent operations, with notice), and structured-output/versioning
extensions to `libs/ai-draft`. Zoom (the target V1 provider) is blocked on
live-tenant transcript-without-recording validation; Teams is the pragmatic
first executable proof.

**Neutral.** Async execution reuses the existing idempotent inbox + BullMQ; no
real message-bus is introduced. The directive names prohibited AI-authority
concepts to define refusal boundaries, which required an exact-file Tier-2
vocabulary exemption for the directive artifact across the three enforcement
surfaces (§29) — recorded here as a governance mechanism, not a relaxation of
the vocabulary discipline.
