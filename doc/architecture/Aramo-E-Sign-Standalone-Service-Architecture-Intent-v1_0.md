# Aramo — E-Sign Standalone Service Architecture Intent v1.0

**State:** ARCHITECTURAL INTENT — RETAIN / DO NOT DRIFT  
**Scope:** Native E-Sign service boundary, future standalone deployment, and future commercial subscription posture  
**Applies to:** `apps/esign-service`, `libs/esign`, `apps/sign-web`, `libs/documents-contracts`, ATS composition through `apps/api`  
**Does not authorize implementation by itself.**

---

## 1. Purpose

Aramo Native E-Sign is intentionally preserved as a **separate bounded context and independently deployable service** so that it can later operate:

1. on its own dedicated production compute environment; and
2. as an independently subscribable Aramo service with plan-based capabilities and usage limits.

Future implementation work must preserve this option and must not collapse E-Sign back into the ATS/API monolith merely for implementation convenience.

This is an architectural intent, not a current product-launch declaration.

---

## 2. Current architecture that MUST be preserved

The intended service boundary is:

```text
Aramo ATS / Core
    |
    |  SignatureProviderPort / HTTP
    v
Aramo E-Sign Service
    |
    +-- envelope lifecycle
    +-- signers
    +-- signing sessions
    +-- disclosure acceptance
    +-- execution
    +-- execution evidence
    +-- execution certificate
    +-- signer notifications

Public signer
    |
    v
sign-web
    |
    v
sign.aramo.ai
    |
    v
Aramo E-Sign Service
```

### Core Documents stays separate from this decision

Core Documents remains the workflow-neutral Documents bounded context composed into `apps/api`.

Do NOT extract Core Documents into a separate microservice merely because E-Sign may later run on dedicated infrastructure.

The intended ownership remains:

- **ATS domains** own ATS business state and workflow transitions.
- **Core Documents** owns canonical documentary state, revisions, artifacts, associations, requirements, and document events.
- **E-Sign** owns signing/execution state and signing evidence.
- **Offer** owns Offer lifecycle.
- **Submittal** owns submit workflow.
- **Placement** owns placement commitment.

No E-Sign implementation may directly mutate Offer, Submittal, Placement, or other ATS lifecycle state.

---

## 3. Dedicated production deployment intent

Aramo intends to retain the ability to deploy E-Sign on a dedicated production environment independent of the main Aramo Core/ATS production box.

Target future topology:

```text
                    Internet
                       |
                sign.aramo.ai
                       |
                 E-Sign ingress
                       |
          +------------v-------------+
          |   Aramo E-Sign PROD      |
          |                          |
          | esign-service            |
          | sign-web                 |
          | E-Sign runtime adapters  |
          +------------+-------------+
                       |
                 private HTTPS
                       |
          +------------v-------------+
          |    Aramo Core PROD       |
          |                          |
          | apps/api                 |
          | Core Documents           |
          | ATS orchestration        |
          +--------------------------+
```

### Required service boundary

Cross-boundary communication must remain explicit service calls/contracts.

- `apps/api -> esign-service`: HTTP via `SignatureProviderPort` or its successor contract.
- `esign-service -> apps/api`: HTTP/service contract only for authoritative document source/evidence write-back interactions.
- `sign-web -> esign-service`: public signer API only.

Do NOT introduce direct E-Sign imports of the Documents Prisma schema or ATS schemas as a shortcut.

---

## 4. Database posture

A dedicated E-Sign compute environment does **not** require immediate physical database separation.

The approved evolutionary posture is:

### Phase A — separate compute, shared PostgreSQL cluster

```text
E-Sign PROD compute
    -> shared PostgreSQL cluster
       -> `esign` schema only
```

This is an acceptable intermediate deployment model.

### Phase B — optional independent E-Sign database

If E-Sign becomes independently subscribed, independently operated, or requires stronger isolation/scaling, the `esign` persistence boundary may later move to an independently operated database.

That future extraction must be handled as an explicit architecture/data-migration increment.

Do NOT prematurely introduce a second database merely to make the service "look" independent.

---

## 5. Future subscription/product intent

Aramo may later offer **Aramo E-Sign** as an independently subscribable service.

Future commercial plans may control capabilities such as:

- envelope volume / monthly usage
- single-signer vs multi-signer execution
- ordered signing
- templates
- reminders / resend
- API access
- webhooks/events
- branding
- evidence/certificate options
- retention / WORM / legal-hold features
- tenant-managed storage
- higher limits
- enterprise security / SLA capabilities

This list is illustrative and does not define current product scope.

### Critical design rule

**Plan logic must not be embedded inside core E-Sign domain lifecycle semantics.**

Keep these separate:

```text
Subscription / Billing
        |
        v
Entitlement / Capability Policy
        |
        v
Usage / Metering
        |
        v
E-Sign API
        |
        v
Envelope / Signer / Execution domain
```

Entitlement answers:

> Is this tenant/account allowed to use this capability?

Usage/metering answers:

> How much of the allowed service has this tenant/account consumed?

E-Sign domain logic answers:

> Given an authorized request, what is the valid signing/execution transition?

Do not conflate those authorities.

---

## 6. Capability/entitlement evolution

The existing `esign` capability may later become the top-level entitlement for E-Sign access.

Future plan-specific capabilities should be additive and explicit, for example conceptually:

```text
esign
esign.api
esign.multi_signer
esign.templates
esign.branding
esign.enterprise_evidence
```

Exact names are NOT ratified by this document.

Do not create plan-specific capability names until a concrete subscription/product directive defines them.

---

## 7. Operational closure before standalone commercialization

Do not represent E-Sign as independently production-ready or separately sellable until the end-to-end operational path is closed and proven.

At minimum, future readiness must demonstrate:

```text
ATS/Core request
  -> envelope create/send
  -> governed signer-link delivery
  -> sign-web session
  -> disclosure / field completion / signature
  -> E-Sign execution
  -> execution evidence/certificate
  -> completion event/write-back
  -> Core Documents EXECUTED state
```

Known operational seams must be closed before commercialization, including governed signer notification/link delivery and automatic completion-to-Documents write-back.

---

## 8. Anti-drift rules for future Claude Code sessions

Future implementation/recon sessions MUST preserve the following unless the PO explicitly changes them:

1. E-Sign remains a separate bounded context.
2. E-Sign remains independently deployable.
3. Core Documents remains inside `apps/api` unless a separate explicit architecture decision changes that.
4. E-Sign never owns ATS business lifecycle transitions.
5. Cross-service data access is contract/API based; no direct cross-schema shortcut.
6. Dedicated E-Sign compute may precede dedicated E-Sign database.
7. Subscription, entitlement, usage, and domain lifecycle are separate concerns.
8. Do not build subscription-plan machinery until product scope requires it.
9. `sign.aramo.ai` is the intended signer origin; actual production deployment must be proven operationally rather than inferred from config.
10. Do not call E-Sign production-ready until its end-to-end send/sign/write-back path is proven.

---

## 9. Trigger for future implementation work

Create an implementation directive only when at least one of these becomes true:

- E-Sign is scheduled for dedicated production infrastructure.
- E-Sign is offered as a separately priced/subscribed capability.
- External/non-ATS consumers need the E-Sign API.
- E-Sign scaling/security/SLA requirements justify independent infrastructure.
- Database isolation becomes an explicit operational requirement.

Until then, retain this as architecture intent and avoid speculative platform work.
