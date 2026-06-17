# ADR-0019: Sourcing Service — Sibling-of-Core Boundary, One-Way Ingestion Gate, Provenance Model

**Status:** Proposed — 2026-05-31. Not yet ratified.

Refusal-layer-adjacent (Charter §8 R2 / R7 / R12 are read against) and program-identity-touching (introduces a new suite component not named in Charter v1.0). Per [doc/adr/README.md](README.md) authorship rule, acceptance requires the **Architect** (program-identity decisions) and the **PO** (refusal-layer adjacent — per Charter §12 stewardship: *"Major updates require Product Owner, Architect, and Business Analyst approval"* and *"Refusal-layer changes require explicit re-justification of the original commitment"*). BA filing the canonical copy to OneDrive `Aramo/locked/` completes ratification per the stewardship operating model. This file remains `Status: Proposed` until then; the ADR index in [doc/adr/README.md](README.md) is updated only on acceptance.

**Date:** 2026-05-31

---

## Context

### What this ADR is about

The Aramo program is moving from "Aramo Core + Astre Thin ATS placeholder" to an all-in-one suite serving multiple staffing-firm tenants. The suite includes a new component — a **Sourcing Service** that performs agentic open-web candidate sourcing — which directly tests Charter §8 R2 ("*Will not act as a sourcing engine as its primary function.*") and Charter §8 R7 ("*Will not perform automated LinkedIn scraping.*"). This ADR records the structural decisions that resolve the §8 reading, the data-flow decisions that make the resolution structurally airtight, and the provenance-modeling decision that makes the Sourcing Service auditable + meterable.

### What is already locked (do not re-decide)

The four suite components — **Aramo Core**, **ATS** (OpenCATS-derived, replacing Astre Thin ATS), **Talent Portal**, **Sourcing Service** — and decisions D1–D5 are recorded in `Aramo-ATS-Alignment-Handover.md` (the Phase A handover from the OpenCATS-design session, 2026-05-31). D1–D5 are the product-framing inputs to this ADR:

- **D1 (Reading A):** Aramo is the suite brand; the ATS is a first-class sibling of Aramo Core, not a function absorbed into Core. The rejected alternative ("Reading B," collapsing ATS into Core) was rejected because it dissolves the system/recruiter boundary that makes the AI-compliance story defensible.
- **D2:** ATS is OpenCATS-derived; replaces both Astre Thin ATS and Astre's live legacy OpenCATS deployment.
- **D3:** Multi-tenant SaaS from day one. Per-tenant entitlement + metering must exist in the tenancy foundation.
- **D4:** Sourcing is OUTSIDE Aramo Core (separate per-tenant SKU). Resolves the open-web-sourcing-vs-R2 collision.
- **D5 (non-negotiable):** The one-way sourcing→Core discipline gate. A sourced lead is, to Core, an unconsented unverified unevidenced lead. It MUST pass through Aramo's existing consent + sanctioned-adapter + entrustability front door before it becomes a Core-ranked Talent.

This ADR makes D4 and D5 structural in the codebase + governance.

### What the three-way drift check established

[doc/_audit/charter-code-drift.md](../_audit/charter-code-drift.md) walked Charter §8 ↔ [doc/milestone-signoffs/M0-refusal-signoff.md](../milestone-signoffs/M0-refusal-signoff.md) ↔ code for each of R1–R13. Three findings bear directly on this ADR:

- **Finding #3 (drift-check §A.R2 + Phase 4 Layer 3).** Per API Contracts v1.0 Phase 4 §3b.4 Layer 3, verbatim ([doc/ARAMO-CHARTER-EXTRACT.md §3b.4](../ARAMO-CHARTER-EXTRACT.md)): *"Adding any new adapter requires repo creation, deployment approval, ADR, and Charter-level approval if conflicting with Charter Section 8."* Charter-level approval is **conditional on §8 conflict**, not unconditional. New sanctioned ingestion surfaces that do not conflict with §8 are gated by ADR + deployment approval only.
- **Finding #4 (drift-check §B.1 R7).** The Phase 4 §3b.3 prohibited list — verbatim *"linkedin / linkedin_scrape / linkedin_bulk / generic_web_scrape"* — is enforced at the AdapterType layer regardless of LinkedIn. The `generic_web_scrape` token is the standing structural defense against open-web-scraping adapters; this ADR upholds it, does not amend it.
- **Finding #6 (drift-check §B.4).** Charter §11 Deferred (Phase 2+) names: *"Cross-tenant graph features / Full-time hiring mode / External ATS integrations / Structural role-family differentiation."* Open-web sourcing is **not** on the deferred list — neither permitted in v1 nor explicitly deferred. The Charter is silent on a sibling sourcing service. This ADR exists specifically because the program should not rely on Charter silence for a load-bearing identity question — the conscious decision is recorded here.

### The forces at play

Two pressures meet on this decision:

1. **Product pressure.** Multiple staffing-firm prospects (per the handover) expect aggressive agentic sourcing as table-stakes. Ceding sourcing altogether cedes the market to scrape-heavy competitors (hireEZ, SeekOut).
2. **Compliance pressure.** Aramo's defensibility under NYC Local Law 144, EU AI Act high-risk classification, EEOC guidance, and SOC2/GDPR/CCPA rests on (a) deterministic auditable entrustability, (b) the consent ledger, (c) the structural separation of system finding/ranking/packaging from recruiter judgment. Open-web sourcing *inside Aramo Core* dissolves (a)-(c).

The Charter's verbatim R2 qualifier — *"as its primary function"* — names the seam through which both pressures can be honored simultaneously: a Sourcing Service that is structurally outside Aramo Core does not make Aramo Core a sourcing engine.

---

## Decisions

### Decision 1 — The Sourcing Service is a sibling of Aramo Core, not a function of Aramo Core

The Aramo suite has four sibling components: **Aramo Core**, **ATS**, **Talent Portal**, **Sourcing Service**. The Sourcing Service is a separately deployable service with its own repository, its own data store for leads-in-flight, and its own per-tenant entitlement under D3. **Aramo Core has no code path that calls the Sourcing Service.** The Sourcing Service has no code path that writes directly to Aramo Core's Talent Graph. The two communicate, when they communicate, only through the existing API Contracts v1.0 Phase 4 ingestion surface (governed by Decision 3 below).

**Why.** Charter §8 R2 reads verbatim: *"Will not act as a sourcing engine as its primary function."* The operative qualifier is **as its primary function**. Aramo Core's primary function — per Charter §3 *"From sourcing to ingestion: Traditional recruiting repeatedly searches for candidates. Aramo ingests once and reuses talent understanding across all future roles."* and §7 *"Aramo v1 is defined by ten specifications: Talent Thresholds, Talent Data Model, Ingestion Pipeline, Recruiter Workflow and System Operation, Examination Output, Entrustability Threshold, Evidence Package, Consent Contract, Talent Portal Minimum"* — is talent intelligence and entrustment. A separately deployed Sourcing Service does not change Aramo Core's primary function; R2 is not triggered.

**What this rules out.** Aramo Core absorbing sourcing as an internal function (the rejected Reading B). Any future PR that adds a sourcing surface inside `apps/api`, any `libs/*` of this repo, or any Aramo Core deployable is in violation of this ADR.

### Decision 2 — Sourcing Service invocation is recruiter-action-gated and job-scoped

The Sourcing Service is invoked **only** by the ATS layer, **only** on a specific job, **only** on explicit recruiter action, **only** when the tenant has the Sourcing Service entitlement under D3. No autonomous or background sourcing. No "continuously source for all open jobs." No "AI scheduled sourcing run." Every Sourcing Service invocation traces to a logged recruiter action against a specific job.

**Why.** Charter §8 R12 reads verbatim: *"Will not replace recruiter judgment with system autonomy."* Charter §3 boxquote: *"**Aramo is AI-assisted, not AI-autonomous.** The system recommends; the recruiter decides."* The Sourcing Service sits outside Aramo Core, so R12 does not formally bind it; but the same posture is mandated here as an ADR-level commitment because (a) it preserves the recruiter-judgment narrative the compliance story rests on, and (b) it prevents a Charter-amendment question being forced by a metric optimization later ("we'd ship more if the Sourcing Service ran on a cron").

**What this rules out.** Cron-scheduled sourcing. AI-triggered sourcing. "Pre-source against tenant prefs." Any sourcing-Service invocation without an explicit recruiter action recorded against a specific job.

### Decision 3 — The one-way sourcing→Core ingestion gate (D5 made structural)

A lead produced by the Sourcing Service is, to Aramo Core, an **unconsented unverified unevidenced lead**. It does NOT enter Core's Talent Graph directly. It does NOT cause a `TalentJobExamination` to be created. It does NOT receive an entrustability tier ([libs/examination/prisma/schema.prisma:55-58](../../libs/examination/prisma/schema.prisma#L55-L58) — `ENTRUSTABLE / WORTH_CONSIDERING / STRETCH`).

A sourced lead becomes a Core-ranked Talent **only** by traversing the existing API Contracts v1.0 Phase 4 ingestion surface, which requires:

1. **Consent captured** through one of the existing consent-acquisition paths, recorded in the `TalentConsentEvent` append-only ledger ([libs/consent/](../../libs/consent/)) — Charter §8 R4 *"Will not infer consent from behavior."*
2. **Evidence ingested** via a sanctioned `SourceType` adapter — the closed enum `talent_direct | indeed | github | astre_import` at [openapi/ingestion.yaml:37,180](../../openapi/ingestion.yaml#L37) — Charter §8 R7 four-layer enforcement.
3. **Normal entrustability examination** runs through `libs/examination` with the canonical version-pinned criteria — Charter §4 *"Entrustability is computed, not assumed."*

Lead → Talent is a discontinuous transition gated by consent + sanctioned adapter + examination, not a continuous spectrum the Sourcing Service moves a record along.

**Why this is the structural defense of multiple refusals at once.**
- R4 (no consent inferred from behavior): the fact that the Sourcing Service surfaced a lead because the lead's bio matched a job is not consent. Consent is the ledger write, not the discovery event.
- R5 (no consent widened through aggregation): a lead being sourced under Tenant A's Sourcing Service entitlement does not grant Core-level consent under Tenant A; the per-tenant per-scope consent state must be written independently.
- R8 (no recruiter override of system classification): a sourced lead enters with no examination; the examination is computed when (and only when) the lead becomes a Talent through Decision 3's gate. There is no "Sourcing Service pre-classified this candidate as Entrustable" path.
- R10 (no internal reasoning exposed): the Sourcing Service's discovery reasoning lives in the Sourcing Service, not in Aramo Core. When a lead becomes a Talent, Core's reasoning starts from scratch with the §2.5 entrustability criteria. The discovery reasoning is not surfaced through Core's Portal or ATS APIs.

**What this rules out.** Any code path in this repo or in the Sourcing Service repo that lets a sourced lead skip consent capture, skip a sanctioned `SourceType` adapter, or skip normal entrustability examination. Any "sourced-and-pre-ranked" data structure that crosses the Sourcing-Service-to-Core boundary.

### Decision 4 — Origin-tagging and examination-eligibility are separate gates

This is the conceptual decision that makes the provenance model work. The handover's D5 collapses into one rule a question that has two parts:

- **Origin (provenance):** *"Which talents in Core were originally surfaced by the Sourcing Service?"* — needed for audit + per-tenant metering. Does NOT affect Aramo Core's ranking, classification, or any candidate-facing surface.
- **Examination-eligibility (the gate):** *"Is this lead eligible to be ranked, classified, surfaced to a recruiter through Aramo Core's surfaces?"* — governed entirely by consent + sanctioned `SourceType` + completed examination per Decision 3. Does NOT depend on origin.

**Why this matters.** Conflating the two leads to either (a) extending the closed `SourceType` enum (Decision 5 Option A) for what is really a metadata concern, or (b) leaving the Sourcing Service unauditable (no first-class provenance trail). Separating them preserves the closed-enum structural defense AND makes provenance queryable.

**What this rules out.** Any code path that uses origin metadata to grant examination eligibility. Any code path that uses examination eligibility to infer origin.

### Decision 5 — Provenance is modeled as a metadata field, not a new `SourceType` enum value

Two options were considered:

**Option A — New sanctioned `SourceType: sourcing_service` value.** Extend the closed enum at [openapi/ingestion.yaml:37,180](../../openapi/ingestion.yaml#L37) from 4 values to 5: `talent_direct | indeed | github | astre_import | sourcing_service`. The Sourcing Service writes leads-becoming-Talents through a `sourcing_service` adapter.

**Option B — Metadata field on the existing ingestion adapter call.** Keep the closed `SourceType` enum at 4 values. Add a non-discriminating metadata field — e.g., `discovery_origin: 'sourcing_service' | null` on the existing `IngestionPayloadRequest` (specific shape TBD; one option is a structured `DiscoveryContext` object — `{ originator: 'sourcing_service', tenant_entitlement_id, discovery_event_id, … }` — written as additive `additionalProperties: false`-compatible fields on the locked ingestion DTOs). The actual `SourceType` is whichever sanctioned adapter the lead's data actually flows through (most commonly `talent_direct` when the candidate uploads their own data after recruiter-mediated outreach; `github` if the data flows through the GitHub adapter; etc.).

**Chosen: Option B (metadata field).** Recommendation per the user-stated framing: *"present both, recommend, justify on auditability + per-tenant metering."*

**Why Option B.**
- **Honors Decision 4 (origin vs eligibility separation).** Option A conflates them: it makes "this was surfaced by the Sourcing Service" *and* "this is a sanctioned ingestion source" share one slot. Option B keeps them in distinct slots, which matches reality (a lead surfaced by the Sourcing Service that consents and uploads via the Talent-Direct path has *two* true facts about it — origin: sourcing_service, ingested-via: talent_direct).
- **Preserves the closed-enum structural defense.** The Phase 4 four-layer LinkedIn refusal (closed AdapterType enum + prohibited-values list + no registration endpoint + `linkedin_automation_allowed: const: false`) gets weaker every time the enum is extended. Option A adds a 5th value to a structure whose strength is its closed-ness. Option B never touches the enum.
- **Per-tenant metering is straightforward.** Per D3 the Sourcing Service has real per-query cost (job-board APIs, computation); metering must be per-tenant. A metadata field is directly queryable: `SELECT tenant_id, COUNT(*) WHERE discovery_origin = 'sourcing_service'`. Option A's enum query is equally simple — but Option B preserves the per-actual-source breakdown too: `SELECT tenant_id, source, COUNT(*) WHERE discovery_origin = 'sourcing_service' GROUP BY source` answers questions Option A cannot.
- **Auditability is stronger under Option B.** "What ingestion path did this Talent take?" — Option A loses this when a sourced-lead-becoming-Talent flows through `talent_direct`; Option B preserves both facts.
- **Phase 4 Layer 3 governance is simpler.** Option A requires a separate ADR + the Phase 4 Layer 3 process described in finding #3 (ADR + deployment approval, no Charter-level approval since `sourcing_service` does not conflict with §8). Option B requires only this ADR plus the routine OpenAPI schema additive change (the metadata field) on the locked Ingestion DTOs.

**Why not Option A.** Two reasons it's tempting and one reason to refuse: tempting because (a) enum values are auditable as first-class queryable values, (b) per-tenant metering becomes one column query. The reason to refuse: extending the `SourceType` enum every time the program adds a *discovery* mechanism mistakes provenance for source. Tomorrow's "VMS feed nominated this lead" and "referral program nominated this lead" would each want their own enum value under Option A's logic; under Option B they're each metadata facets on the same closed-enum source.

**Option A remains the fallback** if a future operational requirement (e.g., regulatory audit, contractual SLA) requires `SourceType` enum-level visibility of Sourcing-Service-originated talents. That future ADR is in-scope of Phase 4 Layer 3 finding #3 (ADR + deployment approval, no Charter-level approval needed).

### Decision 6 — `AdapterType` stays sanctioned; the Sourcing Service is never a scraping adapter

The Sourcing Service does NOT register as a new `AdapterType`. The closed `AdapterType` enum at [doc/ARAMO-CHARTER-EXTRACT.md §3b.2](../ARAMO-CHARTER-EXTRACT.md) — verbatim *"indeed / github / astre_import / candidate_direct"* (post-rename: `talent_direct`) — is preserved as-is. The Phase 4 §3b.3 prohibited list — verbatim *"linkedin / linkedin_scrape / linkedin_bulk / generic_web_scrape"* — is preserved as-is. The Sourcing Service is a discovery layer that operates *upstream* of the sanctioned ingestion adapters; it does not itself ingest into Core.

**Why.** Charter §8 R7 reads verbatim: *"Will not perform automated LinkedIn scraping."* Group 2 §2.3a expands this verbatim: *"LinkedIn is explicitly excluded from automated ingestion in v1 and Phase 2. Manual recruiter add is permitted as an audited exception with required attestation; bulk or automated LinkedIn scraping is prohibited regardless of technical feasibility."* The Phase 4 §3b.3 prohibition of `generic_web_scrape` is the standing structural defense against the next-step generalization of R7 (per finding #4: the `generic_web_scrape` token is the structural seam against open-web-scrape adapters, not just LinkedIn-shaped ones). A Sourcing Service that registered as `generic_web_scrape` would trip Phase 4 Layer 1 (closed enum) and Layer 2 (prohibited list) immediately.

**What this rules out.**
- Sourcing Service implementing any general-purpose web-scrape facility under any `AdapterType` token whose semantics could be reasonably described as `generic_web_scrape`.
- Sourcing Service implementing any LinkedIn-scraping facility under any name.
- Sourcing Service registering as an `AdapterType` of any kind. (Its outputs are leads, not ingestion-payload submissions to Core. When a lead becomes a Talent, the ingestion adapter is one of the four sanctioned ones, with origin tagged per Decision 5.)

The Group 2 §2.3a manual-LinkedIn-add carve-out remains the only suite-wide permitted LinkedIn interaction; it is recruiter-mediated, audited, attestation-required, and does not depend on the Sourcing Service.

### Decision 7 — Charter governance status: this ADR + deployment approval suffice; no Charter amendment required

**Reasoning, tied to verbatim Charter text.**

1. **R2 is not triggered.** Per Decision 1: Aramo Core is not acting as a sourcing engine, and is certainly not doing so *"as its primary function"* (Charter §8 R2 verbatim qualifier). The Sourcing Service sits outside Core.
2. **R7 is upheld, not weakened.** Per Decision 6 + finding #4: `generic_web_scrape` and the LinkedIn-variant tokens remain prohibited at Phase 4 §3b.3 verbatim. The Sourcing Service is constrained to operate within those bounds; it does not register as an adapter. No layer of the four-layer enforcement is amended.
3. **R12 is upheld.** Per Decision 2: every Sourcing-Service invocation is recruiter-action-gated.
4. **R8/R10 are upheld.** Per Decision 3: the lead → Talent transition runs through normal consent + sanctioned adapter + examination; the Sourcing Service does not produce a pre-ranked Talent.
5. **Phase 4 Layer 3 conditional approval (finding #3) applies.** Layer 3 verbatim: *"Adding any new adapter requires repo creation, deployment approval, ADR, and Charter-level approval if conflicting with Charter Section 8."* The Sourcing Service is not an adapter (Decision 6) and does not conflict with §8 (1-4 above). The governance level is therefore: ADR + deployment approval. **This ADR is the ADR.** Deployment approval for the Sourcing-Service deployable is granted (or withheld) by the standard ATS/Sourcing-Service operational governance, separate from Charter §12.
6. **Charter §12 stewardship (finding #6) is the program-identity question.** Charter §12 verbatim: *"Minor updates clarify language / Major updates require Product Owner, Architect, and Business Analyst approval / Refusal-layer changes require explicit re-justification of the original commitment."* Two questions this ADR raises against §12:
   - *Is naming the Sourcing Service in the Charter a Minor update?* Yes — it clarifies that the suite includes this sibling. Charter §11 Deferred list does not currently mention it; a minor update could either add it as a v1 suite component (matches the framing in this ADR) or add it to §11 Deferred (rejected — the Sourcing Service is built, not deferred). The PO holds this decision.
   - *Is this a Refusal-layer change?* No — none of R1–R13 is amended, narrowed, widened, or re-interpreted. Every refusal is read against and confirmed (verbatim citations in 1-4 above). No re-justification is required.

**Conclusion.** No Charter amendment is *required* by the design recorded in Decisions 1-6. Charter §11 *may want* a minor update to clarify the suite framing — that decision is the PO's, and is recorded here as a follow-up question (Consequence #6 below).

---

## Consequences

### Positive

1. **Preserves the compliance moat.** Aramo Core's deterministic entrustability ([libs/examination/](../../libs/examination/)), consent ledger ([libs/consent/](../../libs/consent/)), and structural separation of system finding/ranking/packaging from recruiter judgment are untouched by Sourcing Service work. NYC Local Law 144, EU AI Act high-risk, EEOC, SOC2/GDPR/CCPA defensibility is intact because the Sourcing Service's outputs do not reach the ranking path until they have passed through consent + sanctioned ingestion + examination (Decision 3).
2. **Avoids Charter amendment.** Per Decision 7, this resolution sits inside the Charter's existing permission space. Charter §12 stewardship is preserved for changes that *actually* require it.
3. **Resolves the §C charter-code-drift open question.** [doc/_audit/charter-code-drift.md](../_audit/charter-code-drift.md) §D R7-carve-out + §B.4 R2 + R3 open questions cited the Sourcing Service framing as unresolved; this ADR resolves them concretely (Decisions 3 + 6).
4. **Closed-enum structural defense preserved.** Phase 4's four-layer LinkedIn refusal — particularly Layer 1 (closed `SourceType` + `AdapterType`) and Layer 2 (`x-prohibited-values`) — remains as airtight as at PR-14 ratification ([ci/scripts/verify-ingestion-refusal.ts:52-54](../../ci/scripts/verify-ingestion-refusal.ts#L52-L54), [scripts/verify-vocabulary.sh:36-51](../../scripts/verify-vocabulary.sh#L36-L51)). Decision 5 Option B specifically refuses to weaken Layer 1 by enum extension.
5. **Per-tenant metering and audit are first-class.** Decision 5 Option B's metadata field is directly queryable for the per-tenant Sourcing Service usage that D3 requires, and the per-actual-source breakdown is preserved for compliance audits ("what fraction of our Sourcing-Service-discovered talents ultimately ingested via GitHub vs. Talent-Direct?").

### Negative

1. **Additional operational surface.** The Sourcing Service as a separate deployable means separate observability (ADR-0013 scope extension), separate CI, separate security posture, separate disaster-recovery story (ADR-0017 scope extension). This is the structural cost of D4 — keeping the boundary between Core and sourcing.
2. **Decision 5 Option B introduces additive metadata on locked Ingestion DTOs.** Adding the `discovery_origin` metadata field to `IngestionPayloadRequest` (or analogous shape) is an additive OpenAPI change. It does not amend the closed `SourceType` enum and does not break any existing consumer, but it is a Phase 4 spec touch — needs the standard `openapi:validate` + `openapi:lint` + `ingestion:refusal-check` gates to clear, plus a Pact-consumer test for the new field per [doc/04-pact-contract-test-convention.md](../adr/0004-pact-contract-test-convention.md) (ADR-0004) precedent.
3. **Decision 5 has no CI enforcement against future drift.** Option B is a policy decision: future PRs could ignore the metadata field and route Sourcing-Service-originated leads through `talent_direct` without setting `discovery_origin`. The `ingestion:refusal-check` script cannot detect this (it has no canonical-text basis for "discovery_origin is required when discovery_origin = sourcing_service"). Per-tenant metering relies on disciplined writers + Lead review. A future ADR may need to introduce a CI assertion if drift is observed.
4. **The Sourcing Service repo enforces refusals by discipline, not by Core CI.** Decision 6 binds Sourcing-Service operational behavior (no `generic_web_scrape`, no LinkedIn automation, no autonomous outreach), but the `verify-vocabulary.sh` Tier-1 R7 gate is repo-scoped to *this* repo. The Sourcing Service repo must implement an equivalent gate. [doc/06-lead-review-checklist.md](../06-lead-review-checklist.md) should be amended at the next opportunity to make the Sourcing-Service-repo refusal posture part of the cross-repo Lead review.
5. **D5 gate failure is the single biggest latent compliance risk** (handover §2 D5). If a future PR ever lets a sourced lead skip consent capture or skip a sanctioned `SourceType` adapter, the Charter is preserved in text and defeated in spirit. Decision 3's structural enforcement (no Sourcing-Service-to-Core code path, only the Phase 4 ingestion surface) is the load-bearing defense; it must remain unbroken under refactor pressure.

### Neutral

1. **Doc/03 reconciliation is recommended but separate.** [doc/_audit/charter-code-drift.md](../_audit/charter-code-drift.md) §A.R2 noted [doc/03-refusal-layer.md:47](../03-refusal-layer.md#L47) drops Charter R2's *"as its"* qualifier. Restoring it would make doc/03 align with both Charter v1.0 and this ADR's reasoning. Not blocking; doc-tier cleanup PR.
2. **The Group 2 §2.3a manual-LinkedIn-add carve-out remains unimplemented.** Per drift-check finding §B.2 — Group 2 verbatim *"Manual recruiter add is permitted as an audited exception with required attestation"* — has no documented surface in code. This ADR does not implement the carve-out; the Sourcing Service does not use it. If a future requirement needs it, that is a separate scoped piece of work (recruiter attestation UI + R7_ALLOWLIST extension + Charter-Level Review per the `Aramo-Charter-Review-R7-PR5-LOCKED.md` precedent at [doc/ARAMO-CHARTER-EXTRACT.md Section 5](../ARAMO-CHARTER-EXTRACT.md)).
3. **The Sourcing Service is not yet a named entity in Charter v1.0.** Recording this in an ADR (rather than amending the Charter) is the conscious choice per Decision 7. The PO holds the option to add a §11 or §1 minor update later for future-reader clarity.
4. **The `candidate_direct → talent_direct` rename remains complete on the live code side** (drift-check §C.2) and incomplete on the Architecture v2.x §9.2 BullMQ-job-name side (§C.3). This ADR cites `talent_direct` per the live-code state; it does not depend on the Architecture §9.2 reconciliation.

---

## Ratification path

This ADR is **Proposed**. To become **Accepted**:

1. **Architect** (program-identity decisions per [doc/adr/README.md](README.md) Authorship): reviews Decisions 1-6, accepts or sends back with comments.
2. **PO** (refusal-layer adjacent + Charter §12 *"Major updates require Product Owner, Architect, and Business Analyst approval"*): reviews Decision 7's §8-non-conflict argument, accepts or directs a Charter §11 minor update if the suite framing wants Charter-level mention.
3. **BA** (Charter §12 stewardship operating model): files the canonical Accepted copy to OneDrive `Aramo/locked/` once Architect + PO accept.
4. **This file** is updated to `Status: Accepted — <date>` and the row added to the index in [doc/adr/README.md](README.md).

Until acceptance, no Sourcing Service implementation work should land in this repo (per [doc/02-claude-code-discipline.md](../02-claude-code-discipline.md) Rule 4: refusal-layer-adjacent work requires escalation before code generation).

---

## References

- [doc/ARAMO-CHARTER-EXTRACT.md](../ARAMO-CHARTER-EXTRACT.md) — verbatim Charter §8 + Charter §11 + Charter §12; Phase 4 §3b.3 prohibited list + §3b.4 Layer 3 conditional Charter approval; Group 2 §2.3a LinkedIn exclusion + manual-add carve-out
- [doc/_audit/charter-code-drift.md](../_audit/charter-code-drift.md) — three-way drift check (Charter ↔ M0 sign-off ↔ code); findings #3 (Phase 4 Layer 3), #4 (`generic_web_scrape` prohibition), #6 (Charter silence on Sourcing Service)
- `Aramo-ATS-Alignment-Handover.md` (Phase A context handover, 2026-05-31) — decisions D1-D5; the ten-pillar layer map; the §7 compliance throughline
- [doc/03-refusal-layer.md](../03-refusal-layer.md) — in-repo refusal enforcement table (R1-R13)
- [doc/milestone-signoffs/M0-refusal-signoff.md](../milestone-signoffs/M0-refusal-signoff.md) — closest-to-Charter verbatim repo restatement of R1-R13
- [doc/adr/0011-r7-allowlist-extension-for-openapi-prohibited-values.md](0011-r7-allowlist-extension-for-openapi-prohibited-values.md) — precedent for refusal-layer-adjacent ADR; Charter-Level Review pattern
- [Aramo-Charter-Review-R7-PR5-LOCKED.md](../ARAMO-CHARTER-EXTRACT.md) (OneDrive `Aramo/locked/`) — worked example of a Charter-Level Review under §12 stewardship
- [doc/adr/README.md](README.md) — ADR format, authorship, and when-to-write rules
- API Contracts v1.0 Phase 4 §3b.4 (the Four-Layer LinkedIn Refusal): canonical text at [doc/ARAMO-CHARTER-EXTRACT.md §3b.4](../ARAMO-CHARTER-EXTRACT.md)
- Charter §8 R2, R4, R7, R8, R10, R12; Charter §3 *"Aramo is AI-assisted, not AI-autonomous"*; Charter §11 Deferred list; Charter §12 Stewardship — all at [doc/ARAMO-CHARTER-EXTRACT.md](../ARAMO-CHARTER-EXTRACT.md)
- Earlier-pass draft superseded by this ADR: [doc/_audit/ARAMO-SOURCING-SERVICE-ADR-DRAFT.md](../_audit/ARAMO-SOURCING-SERVICE-ADR-DRAFT.md) (initial draft; this ADR is the canonical version)
