# DRAFT ADR-0019: Sourcing Service as Sibling-of-Core, Refusal-Layer-Compatible

**Status:** Proposed (DRAFT — not yet ratified; this file lives in `doc/_audit/` until the Architect accepts and the BA files the canonical copy to OneDrive per Charter §12 stewardship)

**Date drafted:** 2026-05-31

**Decision authority required to flip to Accepted:** Architect (program-identity decision) + PO (refusal-layer adjacent — see Consequences).

**Companion documents:**
- [ARAMO-CHARTER-EXTRACT.md](../../ARAMO-CHARTER-EXTRACT.md) — verbatim Charter §8 + Group 2 §2.3a + API Contracts Phase 4
- [charter-refusal-audit.md](charter-refusal-audit.md) — full enforcement-mapping audit
- [three-way-drift-check.md](three-way-drift-check.md) — Charter ↔ doc/03 ↔ code drift report
- *(handover document, in conversation 2026-05-31)* — D1–D5 product framing from the OpenCATS-alignment session

**Where to file when Accepted:** `doc/adr/0019-sourcing-service-sibling-boundary.md` (the next available ADR number after 0018; 0015 is reserved by OneDrive `Aramo-ADR-0015-AI-Substrate-Posture-v1_0-LOCKED.md`).

---

## Context

### The product framing

The Aramo suite (per OpenCATS-alignment handover, 2026-05-31) is an "all-in-one AI recruiting platform" composed of four sibling components: **Aramo Core** (talent intelligence + entrustment; this repo's modular monolith), **ATS** (OpenCATS-derived, replacing Astre Thin ATS and Astre's live legacy OpenCATS deployment), **Talent Portal** (candidate-facing surface), and a new **Sourcing Service** that performs agentic open-web candidate sourcing. The Sourcing Service is a per-tenant add-on SKU.

Pillar 5a (agentic open-web sourcing) is one of the ten product pillars; it is the single pillar that most directly tests Aramo Core's Refusal Layer R2 (sourcing) and R7 (LinkedIn). The handover's load-bearing decisions D4 and D5 placed sourcing *outside* Core; this ADR records the boundary and the §8-non-conflict reasoning.

### The two forces at play

1. **Product pressure** — multiple staffing-firm prospects expect "aggressive agentic sourcing" as table-stakes; the alternative (no sourcing capability anywhere in the suite) cedes the market to scrape-heavy competitors (hireEZ, SeekOut).
2. **Compliance pressure** — Aramo Core's defensibility under NYC Local Law 144, EU AI Act high-risk classification, EEOC guidance, SOC2/GDPR/CCPA rests on (a) deterministic auditable entrustability, (b) the consent ledger, and (c) structural separation of system finding/ranking/packaging from recruiter judgment. Open-web sourcing inside Core dissolves separation (a)-(c).

### Resolution path the Charter actually permits

Three findings from [ARAMO-CHARTER-EXTRACT.md](../../ARAMO-CHARTER-EXTRACT.md) make a Charter-faithful resolution available:

**Finding A (Charter §8 R2 textual qualifier).** Charter §8 R2 reads verbatim: "*Will not act as a sourcing engine as its primary function.*" The operative qualifier is "**as its primary function**." A Sourcing Service that is (i) a separate sibling service, not Aramo Core; (ii) per-tenant opt-in (a distinct SKU); (iii) invoked only by the ATS layer on a specific job, on explicit recruiter action — is not Aramo Core's "primary function." Aramo Core's primary function remains talent intelligence and entrustment. The qualifier is the Charter-permitted seam.

**Finding B (Phase 4 Layer 3 conditional Charter approval).** API Contracts v1.0 Phase 4 §3b.4 Layer 3 reads verbatim: "*Adding any new adapter requires repo creation, deployment approval, ADR, and Charter-level approval **if conflicting with Charter Section 8**.*" Charter-level approval is conditional on §8 conflict. A new sanctioned adapter (or `SourceType` enum value) that routes Sourcing-Service-produced leads through normal consent + evidence ingestion does not conflict with §8 — it implements R2/R7 faithfully by funnelling leads through the existing front door. Such an adapter needs ADR + deployment approval; it does not need Charter-level approval.

**Finding C (Phase 4 prohibited list).** API Contracts v1.0 Phase 4 §3b.3 prohibits four `AdapterType` tokens verbatim: `linkedin / linkedin_scrape / linkedin_bulk / generic_web_scrape`. The `generic_web_scrape` token closes the open-web-scrape door at the AdapterType layer regardless of LinkedIn. Any Sourcing Service path that would translate to a `generic_web_scrape`-shaped adapter is structurally blocked.

**Finding D (Charter §11 deferred list silence).** Charter §11 Deferred (Phase 2+) lists: "Cross-tenant graph features / Full-time hiring mode / External ATS integrations / Structural role-family differentiation." Open-web sourcing is *not* on the deferred list. The Charter is silent on a separate, sibling sourcing service — it is neither permitted nor explicitly deferred. This silence is a stewardship question, not a refusal violation: §12 stewardship governs Charter evolution; a sibling service that respects §8 R2 does not require Charter amendment, but the program-identity question (what is the Aramo suite?) is properly recorded in this ADR.

### What this ADR resolves

Three structural choices:
1. **Where does sourcing live?** (D4 — outside Core, sibling service.)
2. **How does the sourced-lead-to-Core handoff work?** (D5 — through the existing `SourceType` adapter front door.)
3. **Does this require a Charter amendment?** (Findings A + B + C + D — no, *if* the boundary and gate hold as specified below.)

---

## Decision

### Decision 1 — Sourcing Service is a sibling of Aramo Core, not a function of Aramo Core

The Aramo suite has four sibling components: **Aramo Core**, **ATS**, **Talent Portal**, and **Sourcing Service**. The Sourcing Service is a separately deployable service with its own repository, its own data store for leads-in-flight, and its own per-tenant entitlement. Aramo Core has no code path that calls the Sourcing Service; the Sourcing Service has no code path that writes directly to Aramo Core's Talent Graph. The two communicate, when they communicate, **only through the existing API Contracts v1.0 Phase 4 ingestion surface** (see Decision 3 below).

**Charter §8 R2 compliance basis:** Charter R2 prohibits Aramo Core from acting as a sourcing engine **as its primary function**. The Sourcing Service is not Aramo Core. Aramo Core's primary function (per Charter §3 and §7) remains talent intelligence and entrustment — continuous ingestion of declared talent, examination, entrustability classification, evidence packaging. R2 is not triggered.

**What this rules out:** Aramo Core absorbing sourcing as an internal function (the rejected "Reading B" from the handover). Any future PR that adds a sourcing surface inside `apps/api` or any `libs/*` of this repo is in violation of this ADR.

### Decision 2 — Sourcing Service invocation is recruiter-action-gated and job-scoped

The Sourcing Service is invoked **only** by the ATS layer, **only** on a specific job, **only** on explicit recruiter action, **only** when the tenant has the Sourcing Service entitlement. No automatic or background sourcing of any kind. No "continuously sourcing in the background." No "sourcing scheduled by AI."

**Charter §8 R12 compliance basis:** R12 prohibits Aramo Core from replacing recruiter judgment with system autonomy. Although the Sourcing Service sits outside Core, the same posture is mandated here as an ADR-level commitment because (a) it preserves the recruiter-judgment narrative the compliance story rests on, and (b) it prevents a Charter-amendment question being forced by a metric optimisation later.

**What this rules out:** "Wake the agent every hour and source for all open jobs." "Pre-source candidates against tenant prefs." "Sourcing Service runs on a cron." All require explicit recruiter action; none of those patterns are permitted.

### Decision 3 — The one-way sourcing→Core ingestion gate (D5)

A lead produced by the Sourcing Service is, to Aramo Core, an **unconsented unverified unevidenced lead**. It does NOT enter Core's Talent Graph directly. It does NOT cause an `Examination` to be created. It does NOT receive an entrustability tier.

A sourced lead becomes a Core-ranked Talent **only** by traversing the existing API Contracts v1.0 Phase 4 ingestion surface, which requires (per Phase 4 §3b.6 Astre Import Conservative Scope + §3b.7 Source Consent Mapping):

1. **Consent captured** through one of the existing consent-acquisition paths (`TalentConsentEvent` ledger entry).
2. **Evidence ingested** via a sanctioned `SourceType` adapter (one of `indeed | github | astre_import | talent_direct` — see Decision 4 below).
3. **Normal entrustability examination** runs through `libs/examination` with the canonical version-pinned criteria.

This is the structural defense of R4 (no consent inferred from behavior), R5 (no consent widened through aggregation), R8 (no recruiter override of system classification), and R10 (no internal reasoning exposed). It is also why Charter R2 is not triggered: Aramo Core's role in this flow is exactly what Charter §3 describes — "Aramo continuously ingests talent from multiple sources … data is deduplicated, normalized, and structured" — the only difference is that the *upstream* of one source happens to be a Sourcing-Service-produced lead.

**What this rules out:** Any code path in this repo or the Sourcing Service that lets a sourced lead skip consent capture, skip a sanctioned `SourceType` adapter, or skip normal entrustability examination.

### Decision 4 — The new `SourceType` value (one of two choices; choose at ratification time)

The Sourcing Service must produce leads that enter Aramo Core through a documented `SourceType` adapter. Two options are viable:

**Option A — New sanctioned `SourceType: sourcing_service` value.** Add a fifth value to the closed `SourceType` enum, matching `AdapterType: sourcing_service`. This adds one ADR-level decision (per Phase 4 §3b.4 Layer 3, Charter approval is *not* required because there is no §8 conflict — the new adapter funnels through normal consent + entrustability). Lets the Sourcing Service's provenance be audited distinctly from Indeed / GitHub / Astre Import / Talent Direct.

**Option B — Route sourced leads through `talent_direct`.** No enum change; the sourced lead's becoming-a-Core-Talent moment is treated as a Talent-Direct intake (which already requires explicit consent at every consent scope, per Group 2 §2.3a consent-state mapping). The Sourcing Service's role is to identify a potential lead and prompt a recruiter-mediated outreach; if the lead consents and uploads, the existing Talent-Direct flow runs. Provenance is opaque (looks like any other Talent-Direct signup).

**Recommendation (subject to Architect ratification):** Option A. Preserves provenance auditing; the additional ADR + Phase 4 enum amendment is small; the alternative obscures the audit trail at a moment compliance most cares about it (where did this Talent come from?). Option A makes "what did the Sourcing Service produce?" a queryable Talent-Graph attribute.

**What this rules out:** Adding a Sourcing-Service ingestion path that does not pass through a sanctioned `SourceType` adapter. Adding any adapter whose semantics could be reasonably described as `generic_web_scrape` — Phase 4 §3b.3 prohibits that token literally.

### Decision 5 — Sourcing Service's own refusal posture (separate-but-aligned)

The Sourcing Service is itself a refusal surface. Even though it sits outside Aramo Core, its design must independently respect:

- **No LinkedIn automation.** Per Charter R7 + Group 2 §2.3a + Phase 4 §3b.3 + the `verify-vocabulary.sh` Tier-1 R7 gate. The R7 sealed allowlist applies only to this repo, but the Sourcing Service's own repo must implement an equivalent gate. **Manual recruiter add of a LinkedIn-sourced candidate** (the Group 2 §2.3a carve-out) is the *only* permitted LinkedIn interaction across the entire suite, with required attestation.
- **No `generic_web_scrape`.** Per Phase 4 §3b.3 — the Sourcing Service must not implement, expose, or document any general-purpose web-scraping capability. Its sources must be specific and named (e.g., job-board APIs with explicit terms, GitHub, public professional directories with TOS-compliant access).
- **No consent inference from sourcing signals.** Per Charter R4. The fact that a candidate's bio matches a job does not create consent. A sourced lead becomes a Core Talent only after the consent ledger is written via Decision 3.
- **No autonomous outreach.** Per Charter R12 + the in-suite outreach gate. The Sourcing Service does not message candidates directly; outreach is the ATS-layer's job, behind Core's consent guard.

### Decision 6 — Charter-level review obligation (the one judgment call this ADR cannot make alone)

This ADR records that **on the verbatim Charter §8 text as extracted in [ARAMO-CHARTER-EXTRACT.md](../../ARAMO-CHARTER-EXTRACT.md), no §8 refusal is triggered by the boundary specified in Decisions 1-5**. That reading rests on (a) the "as its primary function" qualifier in R2, (b) the Sourcing Service being structurally outside Aramo Core, and (c) the D5 gate.

However: the question of *whether the Aramo program intends to include a Sourcing Service in its identity* is a program-identity decision that belongs to the Charter §12 stewardship process. Per Charter §12: "Major updates require Product Owner, Architect, and Business Analyst approval." This ADR is the Architect-level authoring; PO sign-off + BA filing is the path to ratification.

**The Charter does not need to be amended** if the program decides the Sourcing Service is suite-level scope (not Aramo Core scope) and the boundary holds. **The Charter may want to be amended to document the suite framing** for the same reason §11 lists what is deferred — clarity-for-future-readers. That decision is the PO's.

---

## Consequences

### Positive

1. **Preserves the compliance moat.** Aramo Core's deterministic entrustability, consent ledger, and structural separation of system finding/ranking/packaging from recruiter judgment are untouched. The NYC Local Law 144 / EU AI Act / EEOC / SOC2/GDPR/CCPA defensibility is intact because the Sourcing Service's outputs don't reach the ranking path until they have passed through consent + sanctioned ingestion.
2. **Avoids Charter amendment.** Per Findings A + B, this resolution sits inside the Charter's existing permission space. The §12 stewardship process is preserved for changes that actually require it. PO retains the option to amend §11 to document the suite framing for future-reader clarity.
3. **Resolves the §4-collision-1 ambiguity in `doc/_audit/charter-refusal-audit.md`.** That audit's residual question — "how does a sourced lead become a sanctioned Aramo talent?" — is concretely answered by Decision 3 + 4.
4. **Per-tenant entitlement aligns with D3.** The Sourcing Service as a separate SKU lets the metering / entitlement / feature-gating foundation pay for itself; the Sourcing Service has real per-query cost (job-board API spend) that justifies the metering work.
5. **Demo flexibility.** The Sourcing Service can ship on its own track and demo to prospects without forcing Core changes; the Core slice can demo entrustability without dependency on Sourcing Service maturity.

### Negative

1. **More surface to operate.** A separate deployable service means separate observability, separate CI, separate security posture, separate disaster-recovery story. The existing Aramo Core operational substrate (per ADR-0012 IaC, ADR-0013 Observability, ADR-0014 CVE-scanning, ADR-0016 RDS) needs to be either extended or duplicated for the Sourcing Service repo.
2. **Decision 4 requires its own ADR.** Adding `SourceType: sourcing_service` (Option A) requires a follow-on ADR per Phase 4 §3b.4 Layer 3. That ADR is shallow — no §8 conflict — but it must exist before the enum value lands.
3. **Decision 5 is enforcement-by-discipline, not enforcement-by-CI.** Core's refusal-check CI cannot reach into the Sourcing Service's repo. The Sourcing Service must implement its own R7 gate and its own `no_generic_web_scrape` posture. A future Lead review checklist amendment will need to make this explicit.
4. **The D5 gate is the single biggest latent compliance risk** (per handover). If a future PR ever lets a sourced lead skip consent capture or skip the sanctioned `SourceType` adapter, the Charter is preserved in text and defeated in spirit. The gate must be load-bearing.

### Neutral

1. **doc/03-refusal-layer.md may want a small update.** Three-way-drift-check.md flags that doc/03 currently drops Charter R2's "as its primary function" qualifier. Restoring the qualifier in doc/03 will keep doc/03 aligned with both the Charter and this ADR.
2. **The "Sourcing Service" is not named in Charter v1.0.** That is correct and expected — Charter v1.0 was locked in April 2026 and the suite framing emerged in May 2026 from the OpenCATS-alignment session. The naming question (whether Charter §1 + §11 want a future minor-update mention) is PO-decidable; the structural decision in this ADR does not depend on naming.
3. **Charter §3 "Aramo continuously ingests talent from multiple sources" already accommodates the Sourcing Service** as one source's upstream. The ingestion pattern is unchanged.

---

## Appendix — verbatim Charter text relied upon

From [ARAMO-CHARTER-EXTRACT.md](../../ARAMO-CHARTER-EXTRACT.md):

**Charter §8 R2 (verbatim):** "*Will not act as a sourcing engine as its primary function.*"

**Charter §3 The Aramo Approach (lines 144-176):** "Aramo builds and maintains a consent-based Talent Graph. Instead of sourcing candidates per requisition, Aramo continuously ingests talent from multiple sources. … From sourcing to ingestion: Traditional recruiting repeatedly searches for candidates. Aramo ingests once and reuses talent understanding across all future roles. … **Aramo is AI-assisted, not AI-autonomous.** The system recommends; the recruiter decides."

**Charter §11 Deferred (Phase 2+):** "Cross-tenant graph features / Full-time hiring mode / External ATS integrations / Structural role-family differentiation."

**Charter §12 Charter Stewardship:** "The Charter evolves deliberately. Minor updates clarify language / Major updates require Product Owner, Architect, and Business Analyst approval / Refusal-layer changes require explicit re-justification."

**API Contracts v1.0 Phase 4 §3b.3 (Prohibited Adapter Types):** "linkedin / linkedin_scrape / linkedin_bulk / generic_web_scrape"

**API Contracts v1.0 Phase 4 §3b.4 Layer 3:** "Adding any new adapter requires repo creation, deployment approval, ADR, and Charter-level approval if conflicting with Charter Section 8."

**Group 2 §2.3a LinkedIn exclusion (verbatim):** "**LinkedIn is explicitly excluded from automated ingestion in v1 and Phase 2.** Manual recruiter add is permitted as an audited exception with required attestation; bulk or automated LinkedIn scraping is prohibited regardless of technical feasibility."

---

*End of DRAFT ADR-0019. Not Accepted until: (1) Architect ratification of Decision 1-5; (2) PO sign-off per Charter §12 stewardship (Decision 6); (3) BA files canonical copy to OneDrive `Aramo/locked/`; (4) this file is moved to `doc/adr/0019-sourcing-service-sibling-boundary.md` with `Status: Accepted` and the corresponding row added to the ADR index in [doc/adr/README.md](../adr/README.md).*
