# D08 — Submittal, Engagement & Client Policy (AS-DESIGNED ANCHORS)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED
> Sourced ONLY from ratified LOCKED ADRs under `doc/adr/*` and, for instruments ratified after 2026-10-09, from LOCKED directives in the canonical OneDrive `Aramo/locked/` store (listed in the last section). Never synthesized from code.

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

- **ADR-0036 (Accepted, 2026-10-23)** — `doc/adr/0036-talent-intelligence-service.md` supersedes ADR-0029 `:63` for Talent Intelligence only (`:12`) and lists requisition, pipeline, submittal and interview data as Class C, never admitted to Talent Intelligence (`:141`, `:146`). Submittal facts therefore stay ATS-owned.

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

### Canonical LOCKED anchors ratified after 2026-10-09 (OneDrive `Aramo/locked/`)

Read for this refresh. Where an amendment and its parent differ, the amendment governs for the clause it names.

- **Aramo-Talent-Intelligence-Enterprise-Architecture-Delivery-Directive-v1_0-LOCKED.md** (TIP-E2E v1.0, LOCKED 2026-10-12, SHA `5d72f7ee…`):
  - §1.1 examination is mandatory for client submittal: the NOT-NULL columns, evidence-package refusals, confirm pin-reaffirmation and recruiter-UI invariants are preserved; no bypass.
  - §2 the 6-state / 8-transition submittal lifecycle is preserved; the accepted V1 business state `submitted_to_client` is "an attested manual external handoff recorded by Aramo — NOT platform-executed delivery and NOT independently verified client receipt"; receipt confirmation is not established in V1.
  - §2 the examination-tier criteria stay binding: STRETCH cannot proceed, WORTH_CONSIDERING needs justification at confirm, stale or superseded pins are rejected; eligibility, client-submittal policy, client-talent restriction and capacity fire at SEND.
  - §4 binding obligations SEC-O1 (site scoping on submittal writes), SEC-O4 (`@RequireCapability('ats')` parity), SEC-O5 (recruiter handoff attestation and delivery provenance at send) and E11 (correlated audit trail).
  - §6 platform-executed delivery is deferred (DEF-10).
- **Aramo-TIP-E2E-INC-1-Security-and-Handoff-Integrity-Directive-v1_0-LOCKED.md** (LOCKED 2026-10-12; parent TIP-E2E v1.0):
  - §0 preservation invariants (tier restrictions, 6-state lifecycle, tenant isolation, restriction, FLOOR, `consumeSlot`, idempotency, manual-handoff semantics with `aramo_connector` refused).
  - §2 INC-1b: `EntitlementGuard` + `@RequireCapability('ats')` on the submittal controllers; server-resolved site authorization and requisition actor-visibility on create, confirm, mark-ready, submit-to-client (and its alias), confirm-ats and revoke; retain `submittal:approve` for send.
  - §3 INC-1c: interim policy that a valid executed RTR is mandatory before a new `submitted_to_client`; fail closed; activation gated on Legal/PO confirmation.
  - §4 INC-1d: mandatory `handoff_performed: true` (422 `ATTESTATION_MISSING`), `delivery_channel` required, server-set actor and timestamp, no `client_receipt_status` column, never label a self-attested handoff as verified receipt.
  - §5 INC-1e: a read-only, tenant-authorized journey trace over the immutable events and durable IDs; no new `ActivityType`, no general audit platform.
- **Aramo-Talent-Lifecycle-PO-Rulings-R1-R5-Recon-Directive-v1_0-LOCKED.md** (LOCKED 2026-10-20) — §1 R1 "On hold: recruiting continues, client submittal stops"; R5 a client's RTR policy inherits the tenant default.
- **Aramo-Talent-Lifecycle-R1-R5-Amendment-A1-Dispositions-and-Superseding-Amendments-v1_0-LOCKED.md** (LOCKED 2026-10-20; supersedes the earlier LOCKED clauses it names) — AM-1 §2.2 new client submittal stays governed by the open-only submit rule; AM-6 §7 RTR policy resolution: an absent layer or an absent `rtr_present` key is UNRESOLVED and refuses (never "not required"), with atomic enforcement and audit (§7.5) and a production inventory before deploy (§7.6).
- **Aramo-Talent-Lifecycle-R1-R5-Implementation-Directive-v1_2-LOCKED.md** (LOCKED 2026-10-20):
  - §2.2 T-2 lock order (policy advisory shared → submittal → Pipeline → requisition → documents) and the §2.3 proof row for submit-to-client; T-3 bounded transactions, 409 `TRANSACTION_CONFLICT_RETRYABLE`, no automatic retry.
  - §4.1 four-state RTR requirement with `SUBMITTAL_RTR_POLICY_UNRESOLVED` (409, §2.4); §4.2 inheritance through the existing `mergeLayers` and FLOOR, source layer audited as TENANT_DEFAULT / CLIENT_OVERRIDE / REQUISITION_OVERRIDE; §4.4 linearization — exclusive per-tenant advisory lock for publish, shared for readers, database-clock instants; §4.6 the submit checks RTR on its own transaction at t_L and records the applied RTR policy.
  - §5.4 submit vs hold: the submit's requisition read is `FOR SHARE`.
  - §12 C-1 (PO ruling, Option A): a client-submittal policy takes effect immediately on publication; a caller-supplied `effective_from` is refused.
  - §13 PE-2 (recorded, not fixed): submit vs talent-erasure deadlock cycle; erasure not activated; surfaces as a retryable 409 under T-3.
- **Aramo-Pipeline-RTR-Recon-Remediation-Directive-v1_0-LOCKED.md** (LOCKED 2026-10-21) — R2 RTR integrity (DEF-7 RTR starts at Talent responded, DEF-8 no duplicate RTR documents, DEF-12 a new `DECLINED` RTR status, DEF-15(a) RTR requirement copy from the effective policy). The RTR document domain is D10; for D08 these bound the RTR verdict the submit consumes.
- **Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0-LOCKED.md** (LOCKED 2026-10-18; D10 owns it) — for RTR-required policies an exhausted allowance must not silently bypass the RTR and existing client submittal requirements remain enforceable (`:33`); neither quota exhaustion nor provider outage may waive the RTR condition (`:113`). The client-submittal-policy controller cites this directive (as "§D") for refusing a REQUIRED RTR when the tenant has no working signing provider (`apps/api/src/client-submittal-policy/client-submittal-policy.controller.ts:178`); the directive file has no numbered §D heading, so the exact clause behind that refusal is the code's reading of the two lines above.
- **ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED.md** (LOCKED, filed 2026-10-16) — §3.3 subject-bound erasure of the `ClientTalentRestriction` identifying relationship (cited by the CTR migration header); activation not authorized.
