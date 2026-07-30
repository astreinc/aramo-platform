# ADR-0024: Business Policy Engine

- **Status:** **Accepted — LOCKED** (PO-ratified, 2026-07-30)
- **Date:** 2026-07-30
- **Authority:** PO (Purush), ratified this session. Authored by Lead/Architect.
- **Precedence:** Feature ADR. Governed by ADR-0020 (Build For Tenant #50), which wins on any scoping conflict.
- **Substrate baseline:** `origin/main` = `b31bdb7053fccecd6c89b1303de7a4bfae8c12e2`; requisition facts grounded in `libs/requisition/prisma/schema.prisma`.

---

## Context

A recruiter can today add talent to a requisition regardless of its status — including one closed months ago. The narrow question ("restrict or warn?") is the wrong altitude: the same question recurs for submit, interview, offer, hire, document upload, AI actions and integrations. Hard-coding each answer into a UI button produces an authorization model nobody can audit and no tenant can vary.

**ADR-0020 governs the scoping.** Its discriminator resolves it directly: a business policy layer is *foundational* — every tenant exercises operational rules — so it is built now, in the controlled single-tenant window. Approval workflows, expiry scheduling and retention are *specific-client-tier* — so they defer against a named trigger.

**Substrate recon changed the design materially.** The requisition commercial model is mature: structured CONTRACT/PERMANENT compensation, derived `margin_amount`/`markup_percent`/`margin_percent` computed on read, field-level authorization over a gated financial-planning surface, an advertised-comp surface deliberately never derived from gated actuals, multi-recruiter assignment with visibility as a query predicate, VMS provenance, staffing classification.

The **lifecycle** is the thin layer. The schema states *"NO transition rules; NO state-machine trigger; NO event log"*, and `openings_available` has **no decrement logic** — placement never reduces it. Aramo stores lifecycle *declarations* but does not maintain the operational *facts* those declarations are assumed to represent. That distinction shapes every decision below.

## Decision

Aramo will build a **stateless, domain-agnostic Business Policy Engine** over the **existing declarative requisition lifecycle**. Policy may govern declared state immediately. Capacity-dependent policy remains disabled until the requisition domain derives capacity from authoritative commitment records. Policy *evaluates* lifecycle transitions; the requisition domain *exclusively owns* atomic execution, concurrency, mutation history and derived facts.

### D1 — Build against the existing lifecycle; no enum change

The shipped enum is `active · on_hold · full · closed · canceled · lead`. The engine is a matrix over these. New states later become new rows.

**Deferred (Lifecycle v2):** `DRAFT`, `PENDING_APPROVAL`, `EXPIRED`, `ARCHIVED`. These are not status values — they imply approval workflow, scheduling and retention subsystems. **Named trigger:** a real client requirement for requisition approval or retention. Not "a future tenant might."

### D2 — Policies are DATA, not code

Rules are rows: `(resource, action, resource_state, decision, reason_codes, effect_set)`, versioned and published. A tenant needing different rules is a **data operation, never a deploy** (ADR-0020 rule 2). A policy changeable only by shipping code fails the governing principle and is not done.

### D3 — Invariants are NOT a runtime engine

Aramo's hard invariants — no government identifier in the cross-tenant index, no auto-merge without a Tier-A anchor, dormant-until-consented, no score on a person, tenant isolation, prohibited vocabulary — are already enforced at compile time, in CI walls (`ats:refusal-check`, `identity-index:privacy-wall`, `lint:nx-boundaries`) and as schema boundaries. **They stay there.** No runtime "Invariant Engine" is introduced: a runtime check can be misconfigured; a compiled wall cannot.

> **The policy engine has no vocabulary for invariants. It cannot express them, therefore it cannot relax them.** Making an invariant policy-configurable requires a superseding ADR, never a rule row.

### D4 — The engine is domain-agnostic; Lifecycle is its first registered policy package

The engine evaluates `(resource, action, context) → decision` and knows nothing of requisitions, talent or recruiting. Packages layer on top: **Lifecycle** (built now), then Submission, Priority, AI, Integration. Naming a component for its first consumer is how a platform acquires four evaluators doing one job.

### D5 — Resource + action, never domain-named operations

Rules key on a resource and an action: `REQUISITION_TALENT · ADD`, not `ADD_TALENT`. The evaluator holds no recruiting vocabulary.

**Registry gate.** Resource and action identifiers live in policy *rows*, and `verify-vocabulary.sh` gates *source*, not *data*. The resource/action registry is therefore a **declared, source-resident allowlist**; rows may reference only registered identifiers. Free-form resource strings are prohibited. Identifiers use **Talent**, never *candidate*.

### D6 — Action vocabulary must NEVER encode a policy outcome

An action names what the caller **proposes**, never what policy **decided**. A separate override-path identifier (e.g. `CREATE_AFTER_CLOSE`) is prohibited: it bakes an outcome into the domain vocabulary and — more seriously — **lets a caller select the privileged identifier and route around the ordinary path.** The privileged route must never be addressable by the caller.

A distinct action is justified only when the operation has materially different **domain** semantics, never because policy required an override.

### D7 — The evaluator is STATELESS; storage is a separate library

```
libs/policy-engine   STATELESS. Evaluator · PolicyDecision · PolicyContext ·
                     effect registry · resource/action registry.
                     No persistence, no publication, no tenant lookup.

libs/policy-store    Policy definitions · versions · publication · tenant
                     retrieval · caching. No evaluation logic.
```

**Two libraries, not a service.** A separate deployable would put a network boundary inside the product with no forcing function, against Aramo's modular-monolith-then-extract-when-forced pattern. The contract between them is first-class, so extraction later is a transport swap. **Forcing function for a real `policy-service`:** genuine independent scaling, or a consumer outside this deployment.

Neither library contains requisition, pipeline or any other domain behaviour. ATS and Pipeline may depend on their public contracts **without importing each other**, preserving the Pipeline⊥ATS import wall (I15).

### D8 — `PolicyContext` is a formal type

```
PolicyContext
  tenant_id
  resource                 registered identifier (D5)
  action                   registered identifier (D5)
  resource_state           see D13b
  principal_capabilities   already-resolved booleans — never roles
  request_metadata         correlation id, origin (ui | agent | integration)
  environment
  time
  attributes               open map — business hours, region, customer tier,
                           feature flags, AI confidence thresholds
```

`attributes` is the extension point: adding an input is a caller-side change, never an evaluator signature change.

### D9 — The decision is a rich object; effects are fenced

```
PolicyDecision
  decision              ALLOW | DENY | REQUIRES_OVERRIDE | ALLOW_WITH_AUDIT
  reason_code
  policy_version
  rule_id
  audit_required
  override_required
  required_capability?  registered identifier — set when override_required;
                        the engine NAMES it, never resolves it
  reason_required
  warnings[]            advisory, non-blocking
  effects[]             obligations the CALLER must discharge
```

**Effects are declarative obligations from a CLOSED vocabulary — never commands the engine issues.** The engine states *that* an audit record is required; the domain service performs it. An engine that dispatches notifications has become an orchestrator.

Registered effect kinds: `WRITE_AUDIT`, `REQUIRE_REASON`, `NOTIFY_ROLE`, `EMIT_EVENT`, `SHOW_BANNER`. **Effect kinds are versioned with the engine implementation and are NOT tenant-configurable** — a tenant-defined effect would make the evaluator an orchestrator by the back door.

### D10 — Authorization first, policy second; monotonic composition

| Authorization | Policy | Result |
|---|---|---|
| DENY | any | **DENY** |
| ALLOW | DENY | **DENY** |
| ALLOW | REQUIRES_OVERRIDE | resolve `required_capability` (D11); **otherwise DENY** |
| ALLOW | ALLOW_WITH_AUDIT | **ALLOW only if mandatory audit obligations can be discharged** |
| ALLOW | ALLOW | **ALLOW** |

**The policy engine must never grant authority the platform's authorization model has not already conferred.**

**Delegated authority resolves UPSTREAM.** Temporary delegation, emergency/break-glass access, impersonation and workflow delegation are real and are not RBAC — they **materialise into the resolved capability set before the engine is called**. Delegation is another *source* of capability, not an exception to composition; monotonicity survives intact.

**Role is not a policy input.** The caller supplies resolved booleans, so role-to-permission mapping stays inside the authorization model and the two systems cannot drift.

**Fail closed.** If a mandatory effect cannot be discharged, the domain service **must not apply the mutation** — otherwise `ALLOW_WITH_AUDIT` could mutate state after its audit write failed. For transactional commands, mutation and mandatory audit/outbox record **commit atomically** wherever the substrate allows.

### D11 — Override resolution is TWO-PASS

The engine cannot know *which* override capability applies until a rule fires, so `override_authorized` is not an evaluation input:

```
1  authorize the ORDINARY operation          -> authorization_granted
2  evaluate policy                           -> may return REQUIRES_OVERRIDE
                                                + required_capability
3  authorization layer resolves THAT capability
4  capture reason; re-validate
5  domain service disposes the ORIGINAL proposal   (unchanged — D6)
```

An override is: capability check → **reason required** → decision recorded → audit written → proceed. A "Continue?" confirmation is **not** an override; it becomes muscle memory within a week and devalues every genuine one.

### D12 — Multi-package composition

All applicable published packages evaluate against the **same proposal and the same immutable context snapshot**. Decisions compose monotonically — most restrictive wins:

```
DENY  >  REQUIRES_OVERRIDE  >  ALLOW_WITH_AUDIT  >  ALLOW
```

Effects are **unioned and deduplicated**. Conflicting effects, or incompatible required capabilities, **fail closed**. Where several packages return `REQUIRES_OVERRIDE`, **all** their required capabilities must be satisfied — otherwise a later package could accidentally weaken an earlier package's restriction.

### D13 — The lifecycle is DECLARATIVE; policy must never treat a declaration as a derived fact

`active`, `on_hold`, `closed`, `canceled`, `lead` are business declarations, and governing them by policy is correct.

**`full` is the exception.** It is a hand-selected label with **no relationship to `openings_available`**. A requisition can be `full` with three openings free, or `active` with none. Gating submissions on it as a *capacity* signal would be rigorous enforcement of unreliable input — worse than no enforcement, because it manufactures the appearance of governance.

**Normative:** a rule may key on a declared status **or** on a derived fact, but must never assume a declared label carries a derived meaning. Where a rule's rationale depends on a computed fact, the rule keys on that fact.

#### D13b — `resource_state` carries declared and derived state separately

```
status                declared    lifecycle intent
openings              authored    planned capacity
openings_consumed     derived     from authoritative commitments
capacity_balance      derived     openings - openings_consumed   (SIGNED)
openings_available    derived     max(capacity_balance, 0)
over_capacity_by      derived     max(-capacity_balance, 0)
```

They may disagree, and policy handles each honestly.

#### D13c — Capacity is DERIVED from an authoritative record

**Imperative `openings_available--` is prohibited as the source of truth** — the same drift failure rejected for stored margin and for a stored affected-state marker.

**Retain the signed balance.** Clamping to zero erases *how far* capacity is exceeded, and policy needs the distinction between exactly full, one over, and several over. The no-negative invariant applies to the displayed availability or stored projection, **never to the underlying balance**.

**The commitment point may differ by compensation model** and must be ruled, not assumed: a CONTRACT requisition plausibly consumes capacity at assignment commitment/start, a PERMANENT one at accepted placement/hire. The domain normalises both into a canonical `capacity_consuming_commitment` — **never keyed to pipeline stage names**, which tenants can rename.

**Whether an authoritative capacity-consuming record exists has NOT been verified** and must not be assumed. If none exists, defining it is in scope before any capacity computation.

If a stored value is required for performance it is a **projection, not the truth**: transactional or outbox-backed, reconciled by a drift-detection job, not manually editable.

### D14 — Transitions are policy-governed operations; the domain remains transition authority

The absent transition rules do not require a separate state machine. `REQUISITION · CLOSE`, `· REOPEN`, `· PUT_ON_HOLD` are matrix rows subject to authorization, override, provenance and audit.

**The Business Policy Engine is the authorization and contextual-rule EVALUATOR for lifecycle transitions. The requisition domain remains the transition AUTHORITY** — owning atomic mutation, stale-version/concurrency control, event emission, previous/next state recording, the impact assessment, transition-specific domain preconditions, derived-state maintenance and discharging the decision's effects.

### D15 — PROPOSE / DISPOSE (inherited, not invented)

Callers (UI, agents, integrations) **propose**; the engine **evaluates and writes nothing**; the owning domain service alone **disposes** by applying or refusing. This is Aramo's existing doctrine — AI agents propose evidence, never write trust — applied to commands.

### D16 — Command scope only

The engine governs **state-changing commands**. It does **not** participate in read authorization, resource visibility, row filtering or tenant scoping. A read-policy capability requires its own ADR, never a quiet extension of this one.

### D17 — Decision provenance and lifecycle history are DIFFERENT records

**D17a — Decision provenance.** Every evaluation produces: decision, policy version, rule id, inputs, reason code, actor, timestamp, correlation id. Mirrors the resolution-provenance pattern already used in identity resolution — a denial must remain explainable months later.

**D17b — Policy versioning.** `definition · version · effective_from · effective_to · published_by · checksum`. Each decision stores the version that evaluated it.

**D17c — Lifecycle mutation history.** Provenance explains *why a command was permitted*; it does not record *whether and how the state change was applied*. A governed transition needs both. Append-only, minimal — not event sourcing:

```
RequisitionLifecycleEvent
  id · tenant_id · requisition_id
  previous_status · next_status
  actor_id · origin (ui | agent | integration)
  reason_code · policy_decision_id
  occurred_at · correlation_id
```

### D18 — Lifecycle transitions do not rewrite pipeline state

A transition governs **future** commands. Existing entries keep their stage and history, stay readable, and continue to accept notes and compliance documents. Forward progression is denied by default; a privileged user resolves each entry through explicit disposition (complete an authorized step, withdraw, reject, transfer, or an audited override).

**Prohibited:** silently moving talent to Rejected, freezing records without explanation, allowing normal progression, or auto-reopening the requisition.

The transition surfaces an **impact assessment** before confirmation (counts by stage) and emits a status-change event. It mutates no pipeline entry.

**The affected-state marker is DERIVED, not stored.** A persisted `REQUISITION_CLOSED` flag on pipeline entries is a second copy of requisition status and will drift; it is computed at read time. No new column, no backfill, correct by construction.

### D19 — HOT, Bookmark and Watch are three independent concepts

| Concept | Owner | Scope | Status |
|---|---|---|---|
| **HOT** (`is_hot`) | requisition | team-wide operational | exists — keep as the HOT pill, never a star |
| **Bookmark** | user × requisition | personal productivity | build (`user_requisition_bookmark`) |
| **Watch** | user × requisition | notification subscription | future |

**A star must never toggle `is_hot`.** Stars read as personal everywhere else in software; one recruiter starring a requisition would silently re-prioritise it for the whole team. `is_hot` remains filterable and never a sort key.

*(ADR-0019 "Manual Recruiter Rating and the R10 Boundary" is **Rejected**; nothing here revisits it — bookmarks are requisition-scoped, never person-scoped.)*

## Canonical evaluation pipeline

```
Request
   │
   ▼  Authentication
   ▼  Tenant scope + object scope
   ▼  Compile-time invariants      (D3 — CI walls, schema boundaries, compiled
   │                                 code. NOT runtime, NOT reachable by policy)
   ▼  Authorization: RBAC + delegation   (D10 — delegation materialises into the
   │                                      capability set HERE, upstream of policy)
   ▼  Business Policy Engine       (stateless — D7)
   ▼  PolicyDecision               (D9 — decision + obligations)
   ▼  Domain service               (D15 — PROPOSE/DISPOSE; the service alone
   │                                 applies or refuses)
   ▼  Persistence
   ▼  Audit / events               (discharging the decision's effects)
```

Two properties this makes unmissable: **invariants sit above policy and are not evaluated at runtime**, and **the engine participates in command evaluation but never performs a write or owns mutation**.

## Matrix — v1, over the existing lifecycle

Column headings abbreviate `resource · action` (D5): *Add Talent* = `REQUISITION_TALENT · ADD`, *Submit* = `REQUISITION_SUBMISSION · CREATE`, *Note* = `REQUISITION_NOTE · ADD`, *Document* = `REQUISITION_DOCUMENT · ADD`.

| State | Add Talent | Submit Talent | Add Note | Upload Document |
|---|---|---|---|---|
| `active` | ALLOW | ALLOW | ALLOW | ALLOW |
| `on_hold` | **ALLOW** | DENY | ALLOW | ALLOW |
| `full` | REQUIRES_OVERRIDE | **REQUIRES_OVERRIDE** | ALLOW | REQUIRES_OVERRIDE |
| `closed` | DENY | DENY | ALLOW | DENY |
| `canceled` | DENY | DENY | ALLOW | DENY |
| `lead` | ALLOW | DENY | ALLOW | ALLOW |

**`full` + Submit — on DECLARATION grounds, not capacity** (D13). `full` is the owner's declaration that submissions are closed; that is a legitimate override gate. *Capacity* is not, because `full` carries no capacity meaning. **No separate action identifier** (D6): the proposal stays `REQUISITION_SUBMISSION · CREATE`; the engine returns `REQUIRES_OVERRIDE`, `reason_code = SUBMISSIONS_DECLARED_CLOSED`, `required_capability = requisition.override.submission_closed`, effects `REQUIRE_REASON` + `WRITE_AUDIT`. Reason codes: replacement · client-approved overfill · duplicate correction · late-recorded submission · administrative reconciliation.

**A genuine capacity rule is a separate row keyed on the derived fact** — `capacity_balance <= 0` → REQUIRES_OVERRIDE, independent of `status`. **Not enabled until capacity is truthful** (D13c).

**`on_hold` + Add Talent = ALLOW.** A hold is temporary; recruiters keep sourcing so the pipeline is warm when it lifts. Requiring an override for ordinary sourcing trains reflexive overriding, destroying the signal. Submission and forward progression stay DENY until `active`.

**`closed`/`canceled` + Add Note = ALLOW.** Compliance documentation on a terminal requisition must remain possible; denying it produces off-system records.

## Sequencing

**PR-0** — defect #6 (pipeline "Move To" unresponsive). Independent; a plain bug with no policy content.

**PR-0b** — truthful capacity semantics (pull forward from A5). Per D13c: establish the authoritative capacity-consuming record and its canonical commitment event(s); derive capacity from it (or maintain a reconciled projection); define reversal conditions, idempotency, the no-negative invariant on the projection, concurrency control and reconciliation. **Required before any capacity-keyed rule.**

**PR-0c** — minimal `RequisitionLifecycleEvent` (D17c). **Required before any transition-governing consumer.**

**PR-1** — `libs/policy-engine`: stateless evaluator, `PolicyDecision`, `PolicyContext`, resource/action registry, effect registry. No consumers, no persistence, no domain knowledge.
**PR-2** — `libs/policy-store`: storage, versioning, publication, tenant retrieval. No evaluation logic.
**PR-3** — first consumer end-to-end: `REQUISITION_TALENT · ADD`, with decision provenance.
**PR-4** — override capability + reason-code framework; two-pass resolution (D11).
**PR-5** — govern status transitions: policy evaluates, domain executes atomically (D14), writing `RequisitionLifecycleEvent`.
**PR-6** — enable capacity-keyed rules, only after PR-0b proves capacity trustworthy.
**PR-7** — migrate `is_hot` mutation authorization into the engine.

**In parallel, no dependency:** personal bookmarks (`user_requisition_bookmark`).
**Deferred:** Lifecycle v2 (D1's named trigger).

## Consequences

**Positive.** One auditable authorization model across ATS, pipeline, AI actions and integrations. Per-tenant policy becomes a row, satisfying ADR-0020 rule 2. Decisions are explainable through provenance and versioning. New lifecycle states extend the matrix without redesign. Transitions gain governance without a separate workflow product. `RequisitionLifecycleEvent` gives the requisition its first mutation history.

**Negative.** Materially more up-front cost than hard-coding two rules. Every governed command gains an evaluation hop. Policy authorship becomes a real operational responsibility requiring versioning discipline. Capacity-dependent governance is blocked behind PR-0b.

**Neutral.** Governs commands only; reads unchanged. Does not alter the lifecycle state machine. Does not create requisition event sourcing — general field-level change history remains absent.

## Register (outside this ADR's scope)

1. **ADR-0007 is a genuine collision.** `0007-consent-state-read-endpoint-and-read-endpoint-conventions.md` (in the index) and `Aramo-ADR-0007-Talent-RTBF-Anonymization-v1_0-LOCKED.md` are **two different decisions at the same number**. The README states numbers are never reused. Needs reconciliation.
2. **The ADR index is stale.** `doc/adr/README.md` stops at `0020`; `0023` exists in the folder and is unlisted, and `0015` appears only in the `Aramo-ADR-` form. This ADR must be added to the index when filed.
3. **`0021` and `0022` are absent from the repo.** Program memory holds 0021 as the auth-decoupling ADR (canonical-only). Confirm whether the OneDrive canonical numbering diverges from the repo series.
4. **The Pipeline⊥ATS import wall (I15) has no confirmed ADR number.** Program memory cites 0017; the repo's 0017 is RDS Disaster Recovery. Referenced by name here rather than number until resolved.
5. **`full` conflates two facts** — openings filled (derived) and submissions closed (declared) — which can disagree. Lifecycle v2 should separate them.
6. **No client contract / MSA entity exists, and `rate_card_id` is a stub** with no rate-card entity. Relevant to any future rate-validation policy.
7. **No submission-cap field exists.** A submission-limit policy has nothing to key on today.
8. **Requisition change history remains partial.** The schema is "reference CRUD" with no general change log. PR-0c adds lifecycle-transition history only; D17a adds policy-decision provenance. Neither is event sourcing.
