# Aramo — ADR-0015 Amendment v1.2 (Decision 10 revision): Job-Description & Golden-Profile Generation as a Declared AI-Draft Consumer

**Amendment ID:** `Aramo-ADR-0015-Amendment-v1_2-JD-Generation-LOCKED.md`
**Amends:** `Aramo-ADR-0015-AI-Substrate-Posture-v1_0-LOCKED.md` (currently v1.1, Decision 10 added at A8-3b).
**State:** ISSUED for ratification. **PREREQUISITE** — this amendment must be filed/ratified (PL-76) BEFORE any JD-generation code is written. Decision 10 is structurally enforced by the per-lib no-llm-boundary specs (`libs/common/.../no-llm-boundary-assertion.ts`); a new `libs/ai-draft` consumer that is not declared here will FAIL the build. This amendment makes the JD-generation consumer legal.
**Authority:** ADR-0015 Decision 10 ("an LLM in any new surface is a NEW AI-consumption surface requiring an explicit ADR amendment"); the job-module recon (this session); the existing outreach draft→send pattern as the governing precedent.
**Baseline:** `main` HEAD `128322c`. Existing LLM surface: exactly one — `libs/ai-draft` (`anthropic.provider.ts`, `claude-opus-4-7`, via `AiDraftService.generateDraft()`), sole consumer = engagement outreach.

---

## Context

The Job module (Add Job / coupled Requisition + GoldenProfile) introduces an AI capability: a recruiter types a short free-text **brief**, and the system generates (a) an editable **job description (JD)** and (b) a structured **GoldenProfile** (skills, critical_skills, experience, constraints) that feeds the matching engine. This is an LLM consumption — and under Decision 10, a **new declared consumer of `libs/ai-draft`**, which requires this amendment before it is permitted.

This is **not** greenfield AI: it reuses the existing `libs/ai-draft` provider + `AiDraftService` and mirrors the outreach **draft→confirm** governance. It is a second declared consumer of the same governed surface, not a new LLM integration.

---

## Decision 10 — REVISED (additions in **bold**)

AI/LLM provider consumption remains confined to `libs/ai-draft` and its **declared consumers**. The declared consumers are now:

1. **Engagement outreach** (existing) — `libs/engagement` → `AiDraftService.generateDraft()`.
2. **(NEW) Job-description & Golden-Profile generation** — `libs/requisition` (and/or a `libs/job-domain` generation surface) → `AiDraftService` for JD prose + structured GoldenProfile extraction from a recruiter brief.

All other parse/inference surfaces MUST continue to use deterministic heuristics, NOT LLM calls (résumé parse, skill inference, matching analysis remain deterministic — unchanged). Any *further* surface beyond these two declared consumers requires a further Decision 10 amendment.

The no-llm-boundary specs are updated to permit the new declared consumer's import path and to continue rejecting LLM imports everywhere else.

---

## Governing constraints on JD/GoldenProfile generation (binding)

**G1 — Human-in-the-loop, draft→confirm (mirrors outreach).** The AI **proposes**; the recruiter **owns** the final JD and GoldenProfile. Generation is a two-step **draft → review/edit → confirm** flow mirroring the outreach `draft`/`send` two-endpoint pattern:
- a **generate/draft** endpoint that calls the LLM and persists a draft + an audit event (no commitment to the live Requisition/GoldenProfile);
- a **confirm** endpoint that persists the recruiter-reviewed final JD + GoldenProfile, referencing the draft event (cross-event-ref validation, as outreach `send` references `outreach_drafted`).
Nothing AI-generated is committed to the canonical Requisition/GoldenProfile without an explicit recruiter confirm. The recruiter may edit freely before confirm; both the AI draft and the confirmed final persist (editable audit trail).

**G2 — Idempotency + persisted audit (mirrors outreach).** The draft endpoint is idempotent and re-mints on prompt change (as outreach drafting). Every generation persists an `ai_draft_audit_record` (the existing audit mechanism) linking the prompt-shape, the model, and the output. The confirm is idempotent keyed on the draft event.

**G3 — NO consent gate.** Outreach carries a consent gate because it contacts a real external person. JD generation has **no external recipient** — the consent machinery does NOT apply and MUST NOT be bolted on. (Soft/binding consent checks are outreach-specific.)

**G4 — Commercial data is NEVER sent to the LLM (binding new constraint).** The recruiter's brief and the generation prompt MUST exclude all gated commercial/financial data and internal notes: pay rate, bill rate, margin, markup, placement fee, salary, rate cards, and `notes`/internal-notes fields. The LLM sees the **role content** (title, skills, seniority, responsibilities, location, work arrangement, duration) — never the agency's economics or internal commentary. The generation service constructs its prompt from an **allowlist of role-content fields**, not by passing the Requisition wholesale. Rationale: the same field-masking discipline that gates commercial data from unauthorized *users* applies a fortiori to an *external LLM provider* — agency margin must never leave the tenant boundary to a third party.

**G5 — PII redaction (Decision 6) + no raw prompt/completion in logs (Decision 7) STILL APPLY.** Unchanged. The brief is redacted of PII before the LLM call per Decision 6; neither the prompt nor the completion is logged raw per Decision 7.

**G6 — Deterministic surfaces stay deterministic.** This amendment authorizes LLM use ONLY for JD prose + GoldenProfile *generation from a brief*. It does NOT authorize LLM use in matching, examination, résumé parse, or skill inference — those remain deterministic per Decision 10. The GoldenProfile, once generated and confirmed, is consumed by the deterministic matching engine; the LLM does not participate in matching.

**G7 — Model reference.** Reuse the existing `libs/ai-draft` provider/model configuration (`AiDraftService`); this amendment does not introduce a new provider, model string, or API key.

---

## Enforcement

- The `no-llm-boundary` specs are extended to permit the JD-generation consumer's declared import path and to keep rejecting LLM imports in all non-declared surfaces (matching/examination/résumé/skills remain LLM-free, asserted).
- A spec asserts **G4**: the generation prompt construction excludes commercial/notes fields (the allowlist is positively tested — a commercial field added to the Requisition does not leak into the prompt).
- G1/G2 are proven by the draft→confirm endpoint tests (draft persists without committing; confirm requires a valid draft event reference).

---

## Consequences

- **Positive:** the Job module's AI capability is legal, governed by the same proven draft→confirm + audit discipline as outreach, and structurally prevented from leaking agency economics to a third-party LLM.
- **Constraint:** JD-generation code cannot be written until this amendment is ratified (the boundary specs enforce it). This is the intended ordering — the ADR gates the code.
- **Scope:** two declared LLM consumers now exist; a third would require a further amendment.

---

*End of ADR-0015 Amendment v1.2. Adds JD & GoldenProfile generation as the 2nd declared `libs/ai-draft` consumer, governed by draft→confirm + idempotency + audit (mirroring outreach), NO consent gate (no external recipient), and a binding constraint that commercial/financial data + internal notes are NEVER sent to the LLM (G4 — prompt built from a role-content allowlist). PII-redaction (D6) + no-raw-prompt-logging (D7) still apply; matching/examination/résumé/skills stay deterministic (G6). PREREQUISITE to the Job-module PR — must be ratified before the LLM code is legal (no-llm-boundary specs enforce it). BA files; filing = ratification (PL-76).*
