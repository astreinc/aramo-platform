# D08 — Submittal, Engagement & Client Policy (AS-DESIGNED ANCHORS)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED
> Sourced ONLY from ratified LOCKED ADRs under `doc/adr/*`. Never synthesized from code.

## Ratified anchors present in the repo

### ADR-0024 — Business Policy Engine (Accepted — LOCKED, PO-ratified 2026-07-30)
`doc/adr/0024-business-policy-engine.md`

- **§ Decision / D2** (`:31`) — "Policies are DATA, not code"; a tenant needing different rules is a data operation, never a deploy. *(Governs the versioned, published Client-Submittal-Policy and Engagement-Policy layers.)*
- **D7** (`:57`) — two libraries, not a service: `libs/policy-engine` (stateless evaluator) + `libs/policy-store` (definitions, versions, publication, retrieval). "Neither library contains requisition, pipeline or any other domain behaviour." *(Both D08 policy domains compile to / persist through these.)*
- **D9** (`:90`) — `PolicyDecision` is a rich object: `ALLOW | DENY | REQUIRES_OVERRIDE | ALLOW_WITH_AUDIT`, with `reason_code`, `policy_version`, `rule_id`, `required_capability`, effects from a CLOSED vocabulary. "Effects are declarative obligations … never commands the engine issues."
- **D10** (`:111`) — "Authorization first, policy second; monotonic composition." "The policy engine must never grant authority the platform's authorization model has not already conferred." **Fail closed**: if a mandatory effect cannot be discharged, the domain service must not apply the mutation; mutation + mandatory audit/outbox commit atomically.
- **D11** (`:129`) — override resolution is TWO-PASS: capability check → reason required → decision recorded → audit written → proceed. "A 'Continue?' confirmation is not an override."
- **D12** (`:144`) — multi-package composition: most restrictive wins (`DENY > REQUIRES_OVERRIDE > ALLOW_WITH_AUDIT > ALLOW`); where several packages return `REQUIRES_OVERRIDE`, all required capabilities must be satisfied; conflicts fail closed.
- **D15** (`:193`) — PROPOSE / DISPOSE: callers propose; the engine evaluates and writes nothing; the owning domain service alone disposes.
- **D16** (`:197`) — command scope only; the engine governs state-changing commands, never read authorization.
- **D17** (`:201`) — decision provenance (D17a) and lifecycle mutation history (D17c) are DIFFERENT records; each decision stores the policy version that evaluated it (D17b).
- **Matrix — Submit, `full` state** (`:265`, `:274`) — submit on a `full` requisition is `REQUIRES_OVERRIDE` on DECLARATION grounds (not capacity), with `REQUIRE_REASON` + `WRITE_AUDIT` effects; no separate override-path action identifier (D6).
- **Register item 6** (`:316`) — "No client contract / MSA entity exists, and `rate_card_id` is a stub." *(Context for any client-facing rate validation.)*
- **Register item 7** (`:317`) — the ADR records that no submittal-cap field existed at ADR time (paraphrased; the verbatim ADR wording uses a Tier-2-banned term). *(As-designed note: a submittal-limit policy had nothing to key on then; the AS-BUILT now carries `RequisitionSubmittalPolicy.submittal_limit` — a later addition, not anchored here.)*

### ADR-0027 — Client-Talent-Restriction R10 compatibility (LOCKED)
`doc/adr/0027-client-talent-restriction-r10-compatibility.md`

- Anchors the registered `restriction_type` closed-list and the R10 boundary for the restriction entity. The AS-BUILT controller cites "Track 3 / E7 (ADR-0027)" and enforces route-shape-as-authorization (nested `clients/{id}/talent/{id}/restrictions`). *(Section-level anchors not quoted line-by-line in this pass — file present and LOCKED.)*

### ADR-0029 — Pipeline ⊥ ATS boundary, modular monolith (LOCKED)
`doc/adr/0029-pipeline-boundary-modular-monolith.md` / `doc/adr/Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`

- Pipeline libs never hard-import ATS libs; cross-L3 by UUID ref + versioned connector contract; nx boundary tags CI-enforce. *(Governs why `libs/submittal` stays unaware of `@aramo/pipeline`; the two cross ONLY in `apps/api` at `CreateSubmittalOrchestrator` and `SubmitTalentToClientService`.)*

### ADR-0030 — External lifecycle authority (LOCKED)
`doc/adr/0030-external-lifecycle-authority.md`

- The requisition lifecycle transition matrix / external authority governing `RecruitingStatus`. *(Context for the submit gate's `requisition_status == 'open'` requirement.)*

## Where NO repo ADR anchor exists (explicit)

The following AS-BUILT behaviours are governed by LOCKED directives filed to the canonical OneDrive `Aramo/locked` directory, NOT by any `doc/adr/*` file in this repo. No repo anchor can be cited for them; they are intentionally NOT reconstructed from code here:

- The **canonical 6-value submittal state machine** and its 8-transition matrix (M5 PR-8b2 / Group 2 §2.3b Loop 5; SW-2 rename of `submitted_to_ats` → `submitted_to_client`).
- The **recruiter attestation triple** at confirm (ATTESTATION_MISSING) and the Worth-Considering justification requirement (M4 PR-4 / PR-3 directives).
- The **engagement enforcement-mode semantics** (ADVISORY / ENFORCING / ENFORCING_WITH_OVERRIDE) and the COMM-C3 three-state dormant / policy_missing / policy_present model.
- The **DOC-5 same-document executed-RTR** gate and its ordering (window → restriction → engagement → RTR).
- The **SW-1 / L8-B1 re-point** of create and submit into `apps/api`, the server-side pipeline-link derivation, and the serialized slot-consumption safety design.
- The **Client-Submittal-Policy FLOOR** (non-relaxable TENANT floor) and `mergeLayers` provenance semantics (CSP / client-scoped business policy directive).
- The **Resume Revision Lifecycle §9** active-edition eligibility rule enforced at send.

These should be cross-checked against their canonical LOCKED directives; this recon cannot cite them from the repo.
