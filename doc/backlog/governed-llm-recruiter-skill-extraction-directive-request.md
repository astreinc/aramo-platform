# Directive Request — Governed-LLM Skill & Work-History Extraction in the Recruiter Surface

**Type:** Request for a LOCKED directive (PO → Architect relay).
**Requested by:** PO (Purush), 2026-09-11, during the résumé-first Add-Talent rebuild.
**Status:** BLOCKED pending a filed LOCKED directive. Executor HALTed per CLAUDE.md
("spec wins — HALT on code-vs-LOCKED-spec contradiction"); this note is the relay artifact.

---

## What is wanted (product intent)

When a recruiter adds a talent from a résumé, the **Skills** (and ideally **Work History**)
should be **clean, structured, and reviewable** in the Add-Talent flow — not the raw résumé
blob. Target quality = a constrained "extract the skills only" LLM pass, e.g. (real output
from Claude.ai on the Omvignesh Murugesan résumé):

```
Programming Languages: C#, JavaScript, SQL
Frameworks: ASP.NET, ASP.NET MVC, ASP.NET Web API, ASP.NET Core, Express.js
ORM Frameworks: ADO.NET, LINQ, Entity Framework
Database: MS SQL Server, Azure SQL, Cosmos DB, MongoDB
… (grouped, de-duplicated, no prose)
Certifications: 70-483, AZ-900, AZ-204
```

The tenant opts in via the existing setting `resume.extraction_mode = governed_llm`
(default `deterministic`). No per-talent consent is required (PO ruling: the tenant config
is the sole gate).

## Why it is BLOCKED today (the contradiction, cited)

1. **`Aramo-Recruiter-R5-Talent-Create-Resume-Directive-v1_0-LOCKED`**
   - §0 "R5 does NOT": *the structured-skills/work-history surfaces are Core-only, NOT
     recruiter-facing; R5 uses the free-text `key_skills`, NOT the canonical skill evidence.*
   - §6 Halt condition: *HALT if a structured skill-evidence UI is built in the recruiter surface.*
   - §2: *`key_skills` is a free-text field, NOT a structured skill picker.*
2. **`Aramo-ADR-0015-Amendment-v1_3-Declared-Evidence-Extraction-LOCKED`** — the LLM
   declared-evidence extraction IS authorized, but §3.1/§4 scope it to: consume the
   **post-create, PII-redacted `TalentResumeText.redacted_text`**, produce **persisted,
   TalentRecord-keyed evidence rows** (`source='declared'`), feeding the **deterministic
   scoring engine** (matching/examination). It is a **Core/scoring-layer** surface, not a
   recruiter draft-time form feature. §4 keeps résumé **parse deterministic**.
3. **`Aramo-Talent-Detail-Backend-Enablement-Directive-v1_0-LOCKED`** (the current
   Talent-Detail backend directive, #778) does not surface skill/work-history evidence to
   the recruiter detail.

So recruiter-facing LLM skill/work-history extraction (in Add-Talent and/or Talent-Detail)
has **no filed authorization** and directly trips R5 §6. It cannot be built without a
new/amended LOCKED directive.

## What a new directive would need to decide/authorize

- **Supersede R5 §0/§6/§8** for the specific case of surfacing structured/LLM-extracted
  skills (and work history) to the recruiter — or confirm they stay Core-only and the
  recruiter keeps free-text `key_skills` only.
- **Extend ADR-0015 v1.3** (or file v1.4) if extraction is to run at **draft time**
  (pre-create) on raw text for the FORM — v1.3 today authorizes only post-create,
  redacted_text-fed, persisted extraction. Draft-time raises: (a) it would consume
  **un-redacted** raw text (D6/PII posture), (b) it produces a **review draft** (not the
  persisted A2-materialize rows v1.3 describes).
- **Persistence seam on create** — recon found no transactional post-create evidence-persist
  seam in the lib; the only precedent (`TalentAnchorInterceptor`) is best-effort/body-blind.
  Directive must rule: transactional (in create) vs best-effort (interceptor).

## Substrate already in place (low build cost once authorized)

- `libs/talent-extraction` `extractDeclaredEvidence` — constrained-to-source LLM via
  `@aramo/ai-draft`, verbatim-excerpt validation, drops anything not in the text. It ALREADY
  produces `ExtractedSkill[]` + `ExtractedWorkHistory[]`; a pre-create "dry" (no-persist)
  variant is a clean split at the persistence loops (no `talent_id` needed before them).
- Setting `resume.extraction_mode` (`deterministic | governed_llm`) exists + has a Settings
  picker; `TenantSettingService.get(tenantId,'resume.extraction_mode')` is the read seam.
- nx boundary `talent-record (scope:ats) → talent-extraction (scope:cip)` is PERMITTED
  (same class as the existing `talent-record → resume-parse` edge); does NOT violate the
  I15/ATS⊥Pipeline wall. The `no-llm-boundary` gate stays on resume-parse/matching/examination.
- Résumé raw text IS computed synchronously in `resume-parse` `parseBytes` but currently
  discarded (only `text_length` logged) — exposing it would enable draft-time extraction.

## Interim shipped (LOCKED-compliant, no directive needed)

`key_skills` reverted to R5 §2's **free-text field**; the deterministic parser's skills
prefill is **disabled** (its `extractSection` over-captures the whole résumé body on real
résumés — worse than empty). Recruiter enters key skills as free text; garbage chips gone.

## Acceptance (when authorized)

- Tenant `governed_llm` → Add-Talent skills populated clean + grouped (target above),
  reviewable/editable; provenance = résumé; constrained-to-source (every claim in the text).
- Work-history surfaced (form review and/or Talent detail) per the directive's scope.
- Tenant `deterministic` → unchanged (free-text `key_skills`).
- `no-llm-boundary` gates unchanged on resume-parse/matching/examination; new edge carries
  its own posture permitting only the `@aramo/ai-draft` route.
