# Aramo Action Availability Projection — Deferred Architecture Trigger

**Status:** DEFERRED (generic engine) — trigger #4/#5 reached, recon performed, domain-owned readiness retained. See "Trigger status" below.
**Architecture area:** Business Policy / Domain Action Eligibility
**Related architecture:** ADR-0024 Business Policy Engine; `Aramo-Client-Scoped-Business-Policy-Submittal-PreStart-Directive-v1_0-LOCKED`

## Trigger status (2026-09-24 — canonicalized, PR-0)

Re-open triggers **#4** ("Tenant-specific policy makes frontend action mirrors unable to accurately represent current eligibility") and **#5** ("detailed action explanations") are **REACHED** by the client-scoped business policy program: per-client rules at Engagement / Client Submittal / Pre-Start make client-agnostic frontend mirrors inaccurate.

Meeting a trigger authorizes **recon, not implementation** (per this record). The recon was performed against `origin/main` `1c8e06be` (8-agent substrate audit). Ruling (see the LOCKED directive above):

- **A generic Action Availability engine remains DEFERRED and is NOT authorized** — no `available-actions` API, no cross-domain eligibility engine.
- **Domain-owned readiness is retained and extended** — the existing `GET /v1/engagement/readiness` pattern (a pure, non-authoritative read) is the model; per-domain `SubmittalReadiness` / Pre-Start readiness may be added only where a client-divergent frontend mirror exists, and the authoritative command always re-decides at mutation time.
- This satisfies this record's "start with one bounded domain that demonstrates real multi-consumer need" posture: the need is per-client policy divergence within a single interactive consumer, met by domain-owned reads — not a generic layer.

The deferral of the generic layer described below stands unchanged.

## Current ruling

Aramo does **not** require a first-class Action Availability Projection at this time.

The current architecture already safely handles action eligibility:

```text
Frontend affordance
        ↓
Human selects an action
        ↓
Backend authorization
        ↓
Business policy and/or domain gate
        ↓
Authoritative command validation
        ↓
Domain mutation
```

The backend remains authoritative.

Some ATS Web surfaces currently maintain cosmetic frontend mirrors of backend lifecycle/state rules. These mirrors are protected by drift tests. This is controlled duplication and is acceptable while ATS Web remains the primary interactive consumer.

Do not introduce a new workflow engine, policy engine, action-availability engine, or generic cross-domain abstraction solely to remove this duplication.

## Future architectural principle

When Aramo has **multiple independent consumers that need current action eligibility**, prefer exposing **domain-owned action availability from the backend** rather than creating additional client-side mirrors.

For example, today:

```text
ATS Web
   ↓
one primary interactive consumer
```

A first-class availability projection is not currently justified.

A future environment may become:

```text
ATS Web
Mobile / Client API
Autonomous Agent
Integration
Copilot
       │
       ▼
"What actions may happen right now?"
```

At that point the preferred architecture becomes:

```text
Domain authority
      ↓
Read-only Action Availability Projection
      ├── ATS Web
      ├── Agent
      ├── Mobile / Client
      └── Integrations
```

The projection must remain non-authoritative. Actual commands must always re-evaluate authorization, business policy, domain invariants, readiness and concurrency at mutation time.

## Re-open triggers

Re-open this architectural decision when **any one** of the following becomes true:

1. Aramo introduces an agent that can actually execute business/domain actions.
2. A second independent UI or client begins duplicating lifecycle/action eligibility rules.
3. Frontend lifecycle/action drift tests become materially difficult or costly to maintain.
4. Tenant-specific policy makes frontend action mirrors unable to accurately represent current eligibility.
5. Product requires detailed action explanations such as:

   * "Submit unavailable because voice evidence is missing."
   * "Offer unavailable because client selection is incomplete."
6. Product requires a generic **"What can I do next?"** capability for humans, agents, APIs, or integrations.

Meeting a trigger authorizes **recon**, not automatic implementation.

## Required recon when triggered

When any trigger occurs, first reconcile current `origin/main`.

Determine:

* which consumers now require availability;
* which frontend/client rule mirrors exist;
* whether ADR-0024 Business Policy Engine remains the applicable policy substrate;
* which eligibility decisions are Business Policy Engine decisions;
* which remain compiled domain invariants or state machines;
* which depend on evidence, readiness, engagement policy, authorization or database-enforced constraints;
* whether a domain-specific projection is sufficient;
* whether more than one bounded context genuinely needs a shared normalized facade.

Do not assume a generic cross-domain Action Availability framework is warranted.

## Architectural boundaries

If Action Availability is eventually implemented:

### MUST

* remain read-only and non-authoritative;
* reuse existing domain authority rather than recreate rules;
* reuse canonical domain action identities;
* respect tenant, site, object and field-level authorization;
* expose only safe public reason information;
* re-evaluate the command at mutation time;
* keep authoritative command provenance unchanged.

### MUST NOT

* become a workflow engine;
* become another Business Policy Engine;
* move compiled domain invariants into configuration merely for uniformity;
* duplicate business-policy matrices;
* persist "available action" as business state;
* execute actions;
* bypass command-time authorization or domain validation;
* make UI or agent output authoritative;
* attempt to force heterogeneous domain gates into one generic abstraction without evidence that multiple consumers require it.

## Known current-state evidence

At the time this decision was deferred:

* ADR-0024 Business Policy Engine was mature and operational.
* Backend command-time authorization and domain validation were already authoritative.
* ATS Web contained deliberate lifecycle/action mirrors with drift protection.
* No production autonomous agent action-execution/tool-registry surface existed.
* Action eligibility was heterogeneous across Aramo:

  * Business Policy Engine decisions;
  * compiled domain state machines;
  * authorization/segregation-of-duties gates;
  * engagement policy;
  * evidence/readiness checks;
  * cross-domain preconditions;
  * database-enforced lifecycle constraints.

Therefore introducing a universal Action Availability layer at that point would have been premature abstraction.

## Default future implementation posture

If a trigger is reached, start with **one bounded domain that demonstrates real multi-consumer need**.

Prefer:

```text
Domain-owned authority
        ↓
Domain-owned availability projection
        ↓
Thin normalized API contract
```

over:

```text
Generic Action Availability Engine
        ↓
every domain forced into one model
```

Only introduce shared infrastructure after at least two concrete domains demonstrate the same reusable need.

---

**Current disposition:** DEFERRED.

Do not create implementation PRs solely because this backlog record exists.

**Trigger reached → recon → architecture ruling → directive → implementation.**
