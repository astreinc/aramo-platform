# Aramo — Independent Digital Signature Platform Architecture Intent & Implementation Guardrail Directive v1.0

**Directive ID:** `Aramo-E-Sign-Independent-Digital-Signature-Platform-Directive-v1_0`  
**State:** DRAFT — READY FOR PO REVIEW / CANONICAL FILING  
**Nature:** Architecture intent + anti-drift implementation guardrail  
**Scope:** Aramo E-Sign as an independent digital-signature platform, its contract boundary with Aramo Core/ATS, and the disposition of the currently known implementation gaps  
**Applies to:** `apps/esign-service`, `libs/esign`, `apps/sign-web`, `libs/documents-contracts`, Aramo Core integration through `apps/api`, Documents/E-Sign write-back/event seams, signer delivery, deployment topology, contracts, and future provider/subscription evolution  
**Does not authorize broad product expansion by itself.**  
**Canonical filing target once ratified:** Aramo canonical `locked/` location, using the `-LOCKED` filename convention  
**Repo visibility target once ratified:** `doc/architecture/` or equivalent architecture-intent location

---

## 1. Architectural statement — RATIFIED INTENT

Aramo E-Sign is **not an ATS subsystem**.

Aramo E-Sign is an **independent digital-signature platform owned by Aramo**, architecturally comparable in role to an enterprise signing provider such as DocuSign or Adobe Acrobat Sign.

Aramo ATS is **one consumer** of this platform.

The integration model must follow the same boundary expected when integrating an external enterprise signing platform:

```text
Consuming application
        |
        | authenticated command/API contract
        v
Aramo E-Sign
        |
        | durable asynchronous lifecycle events / webhooks
        v
Consuming application
```

Aramo E-Sign owns:
- envelope/agreement lifecycle
- signers/participants
- signing sessions/capabilities
- signer authentication/capability validation
- disclosure acceptance
- document execution
- signature evidence
- executed artifacts
- execution certificates
- signer notifications
- reliable lifecycle-event publication/delivery

The consuming application owns:
- business meaning
- workflow consequences
- ATS/domain transitions
- document/workflow readiness
- placement/submittal/offer decisions
- local documentary projections and associations

The core principle is:

> **E-Sign proves signing state. The consuming system decides what that signing state means.**

---

## 2. Reference mental model — "Aramo-owned DocuSign"

Future implementers should reason about Aramo E-Sign as:

> **A DocuSign-like platform that Aramo happens to own and operate.**

That means Aramo Core must integrate with E-Sign as though E-Sign were an external provider.

The intended posture is:

```text
ARAMO CORE / ATS
    |
    |  create/send/void/query
    v
ARAMO E-SIGN
    |
    |  signer delivery + signing + execution
    |
    |  lifecycle events / webhook delivery
    v
ARAMO CORE / ATS
    |
    |  interpret event
    v
Core Documents / ATS workflow
```

This intent explicitly rejects a design where `apps/api` reaches into E-Sign internals, controls signer sessions, drains E-Sign-owned persistence, or directly governs E-Sign lifecycle.

---

## 3. Provider-neutral integration model

Aramo Core should preserve a provider abstraction so the native platform can coexist conceptually with external providers later.

Target conceptual model:

```text
                   SignatureProviderPort
                           |
            +--------------+--------------+
            |                             |
            v                             v
      Aramo E-Sign                 External provider
      (native platform)            (DocuSign / Adobe)
```

The native provider must not depend on special ATS-only shortcuts that would make this abstraction false.

A future tenant/provider selection model may later support:

```text
Signing provider:
- Aramo E-Sign
- DocuSign
- Adobe Acrobat Sign
```

This directive does **not** authorize implementing external providers now.

It only requires the native platform boundary to remain compatible with that architecture.

---

## 4. Command API direction — consuming application -> E-Sign

The consuming system may call E-Sign synchronously for commands and reads where an immediate acknowledgement is appropriate.

Examples:

```text
POST /envelopes
POST /envelopes/{id}/send
POST /envelopes/{id}/void

GET  /envelopes/{id}
GET  /envelopes/{id}/evidence
GET  /envelopes/{id}/executed
```

Exact paths and schemas remain governed by current code/contracts and future API directives.

The architectural rule is:
- command dispatch may be synchronous
- long-running signing lifecycle must not be synchronously coupled to ATS workflow
- E-Sign must return platform identifiers such as `envelope_id`
- consuming systems persist the provider correlation they need
- consuming systems must not reproduce E-Sign's internal state machine as a second authority

Preferred acknowledgement pattern:

```text
Aramo Core
  -> POST create/send
E-Sign
  -> 201 / 202 + envelope_id
```

After that, workflow progression is event-driven.

---

## 5. Lifecycle direction — E-Sign -> consumers

E-Sign lifecycle updates must be exposed as generic, provider-owned events/webhooks.

Illustrative event vocabulary:

```text
esign.envelope.created.v1
esign.envelope.sent.v1
esign.recipient.delivered.v1
esign.recipient.viewed.v1
esign.recipient.completed.v1
esign.envelope.completed.v1
esign.envelope.declined.v1
esign.envelope.voided.v1
esign.envelope.expired.v1
```

Exact event names are not ratified by this document unless already live.

The important rule is:

> **E-Sign publishes generic signing facts. It does not publish ATS-specific workflow commands.**

Correct:

```text
esign.envelope.completed.v1
```

Incorrect:

```text
rtr.ready_to_submit
offer.accepted
placement.ready
```

Those belong to consuming-domain logic.

---

## 6. Event payload rule

Lifecycle events should carry identifiers and signing facts, not application-specific business semantics.

A generic completion event should conceptually contain:

```text
event_id
event_type
event_version
occurred_at
tenant/account scope
envelope_id
correlation_id
status
artifact/evidence references as identifiers where appropriate
```

It should not contain:
- ATS-only workflow decisions
- raw PDF bytes
- raw signing bearer tokens
- application-specific readiness decisions
- duplicated copies of consuming-system state

The consumer should use the `envelope_id` to retrieve authoritative executed artifacts/evidence when needed.

---

## 7. Signer notification ownership

Signer delivery belongs to E-Sign.

The consumer says, conceptually:

```text
Send this envelope
to this authoritative signer
```

E-Sign owns:
- issuing signer capability/session material
- constructing the signing URL
- delivering the signing request
- retrying platform-owned signer notifications according to future product rules
- ensuring signing tokens remain inside the E-Sign security boundary
- hosting Sign Web / signer experience

The consuming application must not receive raw signing capability tokens merely to relay them.

Hard rule:

> **Raw signing capability material stays inside Aramo E-Sign.**

The public signer frontend talks to E-Sign, not to ATS.

---

## 8. Reliable event delivery ownership

Reliable lifecycle-event delivery is E-Sign responsibility.

The consuming application must not be required to drain E-Sign's internal outbox, inspect E-Sign's database, or run a scheduler over E-Sign-owned persistence.

Target ownership:

```text
Aramo E-Sign
  -> durable outbox
  -> retry policy
  -> delivery worker/scheduler
  -> authenticated webhook/event dispatch

Consumer
  -> authenticated receiver
  -> idempotent handling
  -> business interpretation
```

This is a critical anti-drift rule.

If E-Sign cannot deliver an event because the consumer is temporarily unavailable, E-Sign must eventually retry from its own durable state.

---

## 9. Consumer-side completion handling

The consuming application owns the adapter that translates a generic E-Sign event into local business/document state.

For Aramo Core, the intended pattern is:

```text
E-Sign:
  esign.envelope.completed.v1
             |
             v
Aramo integration receiver
             |
             v
lookup local provider correlation
             |
             v
fetch executed artifact/evidence from E-Sign
             |
             v
Core Documents write-back
             |
             v
Document = EXECUTED
             |
             v
local workflow/readiness re-evaluates
```

This means the integration receiver is **Aramo Core integration code**, not E-Sign domain code.

E-Sign should not call an ATS-specific `documents/esign-writeback` endpoint as a permanent architectural contract.

That existing endpoint may remain as transitional substrate during operational closure, but the target architecture is:

> **generic E-Sign event -> consumer-owned integration adapter -> local write-back**

---

## 10. Disposition of the current implementation gap

The current substrate contains several useful pieces but does not yet fully match the independent-platform intent.

Known current-state gaps include:

1. signer request capability is minted but initial signer delivery is not fully wired
2. E-Sign completion writes a durable outbox event but production draining/retry is not fully operational
3. the current write-back endpoint is consumer-specific and currently lacks a real generic event-consumer path
4. S2S authentication is not yet a mature reusable platform primitive
5. RTR and Offer Letter frontend surfaces are authored but not fully mounted/wired
6. executed-offer and execution-certificate access is not yet role-distinct in the UI
7. deployment/runtime integration has required follow-up hardening

These gaps should be closed in a way that **moves the implementation toward this directive**, not toward tighter ATS/E-Sign coupling.

---

## 11. Required refactoring direction for operational closure

Before finalizing the current E-Sign Operational Closure implementation, the completion seam should be aligned to this architecture.

Preferred target:

```text
E-Sign completion
   -> durable generic completion event
   -> E-Sign-owned retry/delivery
   -> Aramo Core event/webhook receiver
   -> Core-owned integration handler
   -> existing Documents write-back orchestration
```

Avoid making this the permanent model:

```text
E-Sign completion
   -> POST directly to ATS-specific documents/esign-writeback
```

If a short transitional step is required, it must:
- be explicitly labeled transitional
- not become the canonical E-Sign provider contract
- preserve generic event payloads
- keep business interpretation in Aramo Core
- include a follow-up closure item if the generic receiver cannot land in the same increment

The preferred outcome is to land the generic consumer-owned receiver now if reasonably achievable without reopening the wider Documents architecture.

---

## 12. Event transport posture

The directive does **not** mandate one particular transport technology.

Valid implementation choices may include:
- HTTPS webhooks
- SNS/SQS
- another governed event transport
- an internal event-delivery adapter

The architectural requirements are stronger than the technology choice:

1. producer is E-Sign
2. event is generic signing-domain vocabulary
3. delivery is durable/retriable
4. authentication is explicit
5. consumer processing is idempotent
6. consumer owns business interpretation
7. E-Sign does not access consumer-owned databases
8. consumer does not access E-Sign-owned databases

For the current platform, HTTPS webhook-style delivery is acceptable if it is the smallest reliable implementation.

---

## 13. Authentication model

Treat E-Sign as a true separate platform, not as a trusted in-process module.

There are two trust directions.

### A. Consumer -> E-Sign

The E-Sign command API must eventually have a real service/application authentication model suitable for multiple consumers.

Conceptual options include:
- client credentials
- signed API credentials
- mTLS
- OAuth-style service identity
- another governed service-auth mechanism

Do not make private-network location the sole long-term identity signal.

### B. E-Sign -> Consumer

E-Sign lifecycle-event/webhook delivery must be verifiable by the consumer.

Conceptual options include:
- HMAC-signed webhook
- signed event token
- OAuth-authenticated callback
- mTLS

For the current closure increment, a narrow HMAC-signed webhook may be acceptable if no reusable platform S2S system exists.

The implementation must not create a sprawling identity platform merely to close this seam.

---

## 14. Idempotency and delivery semantics

Distributed delivery is expected to be **at least once**, not exactly once.

Consumers must assume duplicate events can occur.

Therefore:

```text
same event delivered twice
     ->
same final local result
```

Required controls:
- unique `event_id`
- consumer-side dedup/idempotency
- idempotent document write-back
- safe retry on temporary failure
- no duplicate executed artifacts
- no duplicate workflow transitions

Do not rely on "the webhook will only arrive once."

---

## 15. E-Sign service independence test

The platform design should satisfy these thought experiments.

### Test A — ATS temporarily unavailable

E-Sign should still be able to:
- host an already-issued signing session
- allow the signer to complete
- generate execution evidence
- persist completion
- queue the completion event
- retry delivery later

### Test B — E-Sign temporarily unavailable

ATS should:
- preserve its own business/document state
- not corrupt local workflow state
- retry or wait for E-Sign recovery
- not fabricate signing completion

### Test C — another Aramo product integrates later

A second product should be able to consume E-Sign without depending on ATS schemas, ATS endpoints, or ATS-specific event names.

If any of these tests fail structurally, the boundary has drifted.

---

## 16. Persistence ownership

E-Sign owns its own signing-domain persistence.

Current physical deployment may use a shared PostgreSQL cluster/schema arrangement.

That does not change ownership.

Hard rule:
- consumers do not read E-Sign tables directly
- E-Sign does not read ATS/Core Documents tables directly

Future dedicated physical database separation remains compatible with this directive.

The service boundary must not depend on shared-database access.

---

## 17. Deployment independence

Aramo E-Sign must remain independently deployable.

Target future shape:

```text
sign.aramo.ai
      |
      v
Aramo E-Sign ingress
      |
      +-- sign-web
      +-- esign-service
      +-- E-Sign delivery/runtime workers
      |
      +-- E-Sign persistence
```

Aramo Core may run elsewhere.

The E-Sign platform should be deployable, upgraded, scaled, and eventually subscribed independently.

Core Documents remains an Aramo Core bounded context unless separately re-architected.

---

## 18. Sign Web ownership

`apps/sign-web` belongs to the E-Sign platform boundary.

It is the public signer experience.

The signer flow should conceptually require only:

```text
signer
  -> sign.aramo.ai
  -> E-Sign signing API
```

The signer should not require:
- ATS account
- recruiter session
- direct ATS API access
- tenant authority from browser input

Capability/session validation remains E-Sign-owned.

---

## 19. Commercial/subscription evolution

This architecture intentionally preserves future commercialization.

Aramo E-Sign may later become:
- an optional Aramo platform subscription
- a separately priced service
- an API product for other Aramo applications
- potentially an externally consumable signing service

Future plan logic must remain outside core signing-domain lifecycle semantics.

Keep distinct:

```text
Subscription / Billing
        |
Entitlement / Capability
        |
Usage / Metering
        |
E-Sign API
        |
Envelope / Signer / Execution domain
```

This directive does not ratify pricing or plan names.

---

## 20. Native vs external provider parity principle

Aramo should aspire to make the native provider integration conceptually equivalent to integrating an external provider.

For each provider:

```text
Core
  -> provider command API
provider
  -> provider-owned signer experience
provider
  -> provider lifecycle event
Core integration adapter
  -> local business/document projection
```

Provider-specific differences belong in adapters, not ATS workflow rules.

This enables future coexistence without rewriting ATS workflows.

---

## 21. Core Documents relationship

Core Documents owns Aramo's canonical documentary state.

E-Sign owns signing state.

The relationship is:

```text
Core Documents
  -> supplies/fixes the document to be signed

E-Sign
  -> executes signing
  -> proves execution

Core integration
  -> stores executed artifacts/proof into Core Documents
```

Do not make E-Sign the canonical owner of ATS document associations, requisition context, offer state, or submittal readiness.

---

## 22. RTR relationship

RTR is an ATS/Core business workflow.

E-Sign only proves execution of the RTR document.

Correct model:

```text
ATS:
  RTR required for Talent T + Requisition R

Core Documents:
  canonical RTR Document D

E-Sign:
  Envelope E executes D

E-Sign event:
  E completed

Core integration:
  D -> EXECUTED

ATS:
  readiness predicate re-evaluates
  -> satisfied
```

E-Sign must not know or enforce:

```text
SUBMITTAL_RTR_NOT_EXECUTED
```

That remains ATS-owned.

---

## 23. Offer relationship

Offer Letter execution remains evidence-only.

E-Sign may report:

```text
Envelope completed
```

Core Documents may record:

```text
Offer Letter Document = EXECUTED
```

Offer domain may still remain:

```text
Offer = SENT
```

E-Sign must not transition the Offer.

Future multi-condition acceptance remains Offer-domain policy.

---

## 24. API/event contract governance

All cross-service seams must be explicit contracts.

Expected contract classes:

### Consumer -> E-Sign
- create envelope
- send envelope
- query envelope
- retrieve evidence
- retrieve executed artifacts
- void envelope

### E-Sign -> Consumer
- lifecycle webhook/event contract

The generic completion event should become a first-class contract.

If Pact remains the repo's chosen contract framework, both directions must be represented by real consumers/providers.

Do not create synthetic contracts for nonexistent consumers.

---

## 25. Versioning

E-Sign events and external-facing APIs must be versionable.

Examples:

```text
esign.envelope.completed.v1
/v1/esign/envelopes
```

Breaking changes require explicit version evolution.

Do not silently change event payload meaning in place.

---

## 26. Observability

Because the platform is asynchronous, correlation is mandatory.

Carry and log non-secret identifiers such as:
- request id
- correlation id
- event id
- envelope id
- local provider-reference id
- tenant/account id

Never log:
- raw signing capabilities
- bearer tokens
- full sensitive document contents
- secret credentials

Observability should allow tracing:

```text
Core command
  -> E-Sign envelope
  -> signer execution
  -> lifecycle event
  -> Core consumer
  -> Documents write-back
```

---

## 27. Error ownership

E-Sign API errors describe E-Sign-domain failures.

Examples:
- invalid envelope transition
- signer unavailable
- invalid signing capability
- expired session
- execution failure

Consumer-domain errors remain consumer-owned.

Examples:
- RTR not satisfied
- Offer not eligible
- Placement rule failed

Do not leak ATS policy into E-Sign error vocabulary.

---

## 28. Retry ownership

### E-Sign owns retry for:
- signer notification delivery where platform policy allows it
- lifecycle event/webhook delivery
- its own outbox draining

### Consumer owns retry for:
- command dispatch to E-Sign
- local processing of received events
- local artifact fetch/write-back where appropriate

Neither side should reach into the other's persistence to retry work.

---

## 29. Current operational-closure directive impact

The previously drafted E-Sign Operational Closure directive must be reconciled with this architecture before implementation.

Required adjustments:

1. **OC-1 signer delivery**
   - remains valid
   - signer link generation/delivery stays entirely inside E-Sign

2. **OC-2 completion/write-back**
   - must be reframed
   - E-Sign publishes a generic completion event
   - Aramo Core owns the event consumer and Documents write-back adapter
   - direct E-Sign -> ATS-specific write-back must not become the permanent provider contract

3. **Retry**
   - E-Sign owns durable event-delivery retry
   - consumer owns idempotent event processing

4. **S2S auth**
   - event/webhook authentication belongs in the platform contract
   - private-network trust alone is not the target architecture

5. **OC-3/OC-4 deployment hardening**
   - remain compatible
   - E-Sign stays independently deployable

6. **RTR/Offer UI work**
   - remains consuming-application work
   - should depend only on the provider contract and local projections

Implementation MUST update the operational-closure plan before code changes.

---

## 30. What this directive does NOT authorize

This directive does not by itself authorize:
- external DocuSign integration
- Adobe Sign integration
- multi-provider tenant settings
- public third-party E-Sign API launch
- billing
- pricing
- subscription tiers
- metering
- dedicated database migration
- dedicated production-box cutover
- multi-signer expansion
- organization/counterparty signing
- advanced template product work
- WORM/legal-hold work
- generic Documents UI
- Model-C Offer acceptance
- workflow-engine introduction

These remain separate future increments.

---

## 31. Anti-drift rules for Claude Code and future implementers

Future implementation sessions MUST NOT:

1. treat E-Sign as an `apps/api` feature
2. move signing lifecycle into Core Documents
3. let ATS directly inspect E-Sign tables
4. let E-Sign directly inspect ATS/Core Documents tables
5. make ATS drain E-Sign's internal outbox
6. expose raw signing tokens to ATS
7. encode ATS workflow semantics into E-Sign events
8. make E-Sign call ATS-specific workflow transitions
9. rely permanently on Docker/private-network location as identity
10. make `documents/esign-writeback` the canonical external provider contract
11. couple Sign Web to ATS authentication
12. duplicate E-Sign envelope state as a second authority in ATS
13. introduce subscription-plan decisions into envelope state transitions
14. collapse E-Sign back into the monolith for convenience

Any requested change violating these rules requires explicit PO/architecture reconsideration.

---

## 32. Implementation trigger

Before future E-Sign work begins, the executor should classify the work as one of:
- E-Sign platform-domain work
- E-Sign public signer work
- E-Sign integration-contract work
- consuming-application adapter work
- deployment/infrastructure work
- commercial/subscription work

If work spans multiple categories, keep ownership boundaries explicit.

---

## 33. Acceptance test for this architecture

A future mature implementation should be able to prove:

```text
1. Aramo Core creates an envelope through a contract API
2. E-Sign returns an envelope id
3. E-Sign sends the signing request itself
4. signer completes entirely through Sign Web + E-Sign
5. Core may be temporarily unavailable during signing
6. E-Sign still reaches COMPLETED and persists evidence
7. E-Sign queues a generic completion event
8. E-Sign retries until delivery succeeds
9. Core authenticates and idempotently consumes the event
10. Core retrieves authoritative executed artifacts
11. Core Documents becomes EXECUTED
12. RTR/Offer/local workflow interprets that result
13. no cross-schema access occurred
14. no raw signing token left E-Sign
15. duplicate event delivery caused no duplicate business effect
```

That is the target definition of an independent digital-signature platform integration.

---

## 34. Final architecture picture

```text
                          ARAMO CORE / ATS

 Recruiter / workflow
          |
          v
  Core Documents
          |
          | provider-neutral command contract
          v
  SignatureProviderPort
          |
          +------------------------------+
          |                              |
          v                              v
   ARAMO E-SIGN                    External provider
   independent platform            future adapter
          |
          +-- Envelope API
          +-- Signer/session runtime
          +-- Sign Web
          +-- Notifications
          +-- Execution/evidence
          +-- Durable outbox
          +-- Retry/delivery
          |
          | generic authenticated lifecycle event
          v
  Consumer integration receiver
          |
          +-- correlate envelope
          +-- fetch evidence/artifacts
          +-- Documents write-back
          +-- re-evaluate local workflow
```

The defining boundary is:

> **Commands go into E-Sign. Signing happens inside E-Sign. Generic lifecycle facts come out of E-Sign. Business consequences happen in the consumer.**

---

## 35. Status of prior architecture

This directive does **not** reopen the sound foundations already delivered:
- canonical Core Documents remains retained
- Native E-Sign bounded context remains retained
- Sign Web remains retained
- RTR readiness ownership remains retained
- Offer evidence-only ownership remains retained
- `SignatureProviderPort` remains directionally correct

It clarifies and strengthens the missing platform boundary around:
- signer delivery ownership
- generic asynchronous completion delivery
- retry ownership
- consumer-owned write-back
- independent service authentication
- future provider parity

---

*End of directive. Aramo E-Sign is an independent digital-signature platform, not an ATS subsystem. Build it as an Aramo-owned signing provider with authenticated command APIs, E-Sign-owned signer delivery and execution, durable generic lifecycle events, E-Sign-owned retry, and consumer-owned business interpretation.*
