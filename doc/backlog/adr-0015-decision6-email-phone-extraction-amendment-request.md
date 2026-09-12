# Amendment Request — ADR-0015 Decision 6: scoped email/phone exception for governed résumé-draft extraction

**Type:** Request for a LOCKED Architect amendment (PO → Architect relay).
**Requested by:** PO (Purush), 2026-09-11.
**Decision on the table (PO-selected):** In `resume.extraction_mode = governed_llm`, the
governed LLM must be the **sole** résumé extractor for **all** supported Add-Talent fields,
**including email and phone**. This requires amending ADR-0015 Decision 6 (PII redaction) so
email/phone can reach the model on this one path.
**Executor status:** Building everything else now; the **email/phone-through-model** piece is
**HELD** pending this filed amendment (per the option the PO chose). No code weakens redaction
until the amendment is filed.

---

## The grounded conflict

- **ADR-0015 Decision 6 / "Ruling 6" (LOCKED, closed, not opt-out):**
  `libs/ai-draft/src/lib/redaction.ts:29-37` replaces every **email → `[REDACTED:EMAIL]`** and
  every **US phone → `[REDACTED:PHONE]`**; header (`:1-2`) states *"Ruling 6 (closed; opt-out is
  NOT configurable at PR-5)."* `ai-draft.service.ts:85` runs `redactPii(input.prompt)` and `:126`
  sends `redactedInput.redactedText` (the redacted text) to the model. **The model never sees
  email/phone.**
- **Implementation directive §17:** *"Follow existing ai-draft redaction/audit behavior. Do not
  weaken it."*
- **PO ruling (this request):** governed_llm LLM extracts email/phone too.

These cannot coexist: extracting email/phone via the LLM requires the model to receive them,
which the closed redaction forbids. Hence the amendment.

## What the amendment must authorize (proposed shape — Architect to ratify)

1. A **scoped, opt-in redaction policy** on `AiDraftService.generateDraft`: a per-call option
   (default OFF = today's full redaction, backward-compatible) that **exempts EMAIL and PHONE
   only** — **SSN, credit-card, and ABA routing stay redacted always**.
2. The exemption is invocable **only** by the governed résumé-draft extraction consumer
   (`talent-extraction.extractResumeDraft`), for the purpose of populating Add-Talent contact
   anchors the recruiter then reviews. No other consumer may set it.
3. **Compensating controls (keep the audit posture, §17/§18):**
   - The `ai_draft` audit event records that the email/phone exemption was applied (a boolean +
     the consumer id / prompt-version), so every exempted call is attributable.
   - PII floor unchanged: raw text / full extracted PII object / prompts / responses are **never
     logged** — only counts + operational metadata.
   - Output stays a **DRAFT proposal** (not persisted evidence, not verified); recruiter review
     before create is mandatory; every value stays constrained-to-source (verbatim excerpt).
4. Model-version pinning (Decision 8) + governed provider (Decision 1) unchanged.

## Implementation once filed (small, additive)

- `redactPii(text, { exemptKinds?: ('EMAIL'|'PHONE')[] })` — default exempts nothing (identical
  to today). `generateDraft` gains an optional `redaction_policy` passed through only when the
  résumé-draft consumer sets it.
- `extractResumeDraft` prompt/DTO gains a **contact group** (`email`, `phone` with
  `source_excerpt`); post-model deterministic **validators** verify email syntax + normalize
  phone + confirm the excerpt exists (validation, not a second extractor).
- The FE proposal already carries `email1`/`phone_cell`; they populate with `governed_llm_resume`
  provenance instead of staying recruiter-entered.

## Interim behavior (authorized now, no amendment)

Governed_llm mode extracts **name (split), location, employer, title, and clean skills** via the
LLM (sole extractor; no deterministic parser runs). **Email/phone are recruiter-entered** (the
admission gate still requires them). When the amendment lands, email/phone become an additive
LLM contact group — no rework of the surrounding flow.

## Cross-refs
- Implementation directive: "Add Talent — Governed LLM Resume Extraction + Deterministic Fallback" (LOCKED).
- `doc/backlog/governed-llm-recruiter-skill-extraction-directive-request.md` (the parent slice authorization, now filed as the directive above).
- ADR-0015 v1.0 Decision 6; Amendment v1.3 (Declared-Evidence Extraction).
