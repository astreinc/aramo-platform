# Aramo — E-Sign Dedicated Production + Subscription Service Backlog Directive v1.0

**State:** BACKLOG — DO NOT BUILD UNTIL ACTIVATED BY PO  
**Nature:** Future architecture / deployment / commercialization increment  
**Depends on:** Native E-Sign operational closure and a proven end-to-end signing/write-back path  
**Canonical handling:** retain in repo backlog; when activated, carry this directive into the Aramo canonical backlog/locked process using the same filename/version lineage and record the then-current `origin/main` baseline.

---

## 1. Intent

Preserve and eventually exercise Aramo Native E-Sign as:

1. an independently deployable production service on dedicated compute; and
2. an optional independently subscribable Aramo product/service with plan-based entitlements and usage controls.

This directive exists to prevent future implementation drift. It does NOT authorize immediate infrastructure extraction, database separation, billing work, or public API commercialization.

---

## 2. Preconditions to activate this backlog item

Do not start this directive until the PO explicitly activates it and the following are re-confirmed against current `origin/main`:

1. `apps/esign-service` remains independently bootable/deployable.
2. `apps/api -> esign-service` remains an HTTP/contract boundary.
3. `esign-service -> apps/api` document-source/write-back interactions remain contract/API based.
4. `apps/sign-web` remains the public signer frontend.
5. `sign.aramo.ai` remains the intended signer origin.
6. The core send/sign/execute/write-back path is operationally complete.
7. No current implementation has collapsed E-Sign into Core Documents or ATS lifecycle ownership.

Mismatch with these assumptions is a RECON result, not permission to improvise a redesign.

---

## 3. Future target topology

```text
                  sign.aramo.ai
                       |
                E-Sign ingress
                       |
            +----------v-----------+
            |  E-Sign PROD         |
            |                      |
            |  sign-web            |
            |  esign-service       |
            |  esign runtime ports |
            +----------+-----------+
                       |
                private service API
                       |
            +----------v-----------+
            |  Aramo Core PROD     |
            |                      |
            |  apps/api            |
            |  Core Documents      |
            |  ATS orchestration   |
            +----------------------+
```

Core Documents remains in Core PROD unless separately authorized.

---

## 4. Workstreams when activated

### A. Operational closure gate

Before infrastructure split or commercial packaging, prove the real path:

```text
create/send envelope
-> signer notification/link delivery
-> sign-web
-> complete signature
-> execution evidence/certificate
-> event/write-back
-> canonical Document = EXECUTED
```

No standalone-service launch without this proof.

### B. Independent build/deployment

Make E-Sign independently buildable, deployable, observable, and rollbackable.

Expected concerns to recon and close:

- image build included in governed production build path
- independent release/version stamp
- health/readiness endpoints and deployment checks
- service discovery/private DNS
- TLS/ingress ownership for `sign.aramo.ai`
- startup dependency handling
- secrets/config isolation
- logs/metrics/tracing
- backup/restore responsibilities
- independent rollback

Do not assume current compose wiring is the final production mechanism.

### C. Service-to-service security

Replace any trust that depends only on network placement or caller-supplied tenant identifiers with the approved Aramo service-auth model appropriate at that future baseline.

Requirements must include:

- authenticated service identity
- authoritative tenant context
- replay/request integrity as appropriate
- least-privilege service permissions
- no browser authority over tenant identity

Exact mechanism is to be reconfirmed against current platform auth architecture when activated.

### D. Persistence isolation decision

Explicitly choose one:

**D1 — shared PostgreSQL cluster, dedicated `esign` schema**  
or  
**D2 — independent E-Sign database**

Default posture at activation should be **D1 unless requirements justify D2**.

If D2 is chosen, require a separate data-migration/cutover plan with rollback, reconciliation, and contract tests. Do not perform cross-database extraction opportunistically inside deployment work.

### E. Subscription and entitlement model

Introduce commercial controls outside core E-Sign state-transition logic.

Separate:

- subscription/plan
- entitlement/capability
- usage/metering
- billing
- E-Sign domain lifecycle

A future plan model may include capabilities such as basic signing, multi-signer, templates, API access, branding, reminders, enterprise evidence, retention, tenant-managed storage, and volume tiers.

No plan names, prices, quotas, or exact capability vocabulary are authorized by this backlog directive.

### F. Metering

If separately subscribed, define auditable usage units before billing integration.

Potential units to evaluate:

- envelopes created
- envelopes sent
- envelopes completed
- signer transactions
- API calls
- storage/retention volume

Select one or more only through a product/commercial ruling. Do not infer billing units from implementation counters.

### G. External API posture

If non-Aramo clients will consume E-Sign, perform a separate API-product review for:

- external authentication
- tenant/account provisioning
- API versioning
- idempotency
- rate limits
- webhooks/event delivery
- SDK/documentation posture
- support/SLA
- abuse protection
- data residency/compliance requirements

Internal `SignatureProviderPort` contracts are not automatically a public API contract.

---

## 5. Hard architecture invariants

When this backlog item is implemented:

1. **E-Sign remains authoritative only for signing/execution state.**
2. **Core Documents remains authoritative for canonical document state.**
3. **ATS domains remain authoritative for ATS workflow/business lifecycle.**
4. **No direct E-Sign mutation of Offer/Submittal/Placement state.**
5. **No direct cross-service Prisma/schema access as a shortcut.**
6. **No subscription logic inside envelope/signature transition rules.**
7. **No physical DB split without explicit migration/cutover authority.**
8. **No public-product claim based only on repository configuration. Operational deployment must be proven.**

---

## 6. Explicitly out of scope until separately authorized

- moving Core Documents into its own service
- changing Offer acceptance policy
- changing Submittal/RTR business rules
- replacing the existing Documents contract boundary
- pricing decisions
- plan naming
- billing provider selection
- database-per-tenant
- multi-region architecture
- legal/compliance certification claims
- tenant-managed storage implementation
- WORM/legal-hold implementation unless separately prioritized

---

## 7. Activation recon requirements

When the PO activates this backlog item, the first step is READ-ONLY recon of current `origin/main` and production topology.

The recon must report:

1. current service/project inventory
2. current E-Sign HTTP/API/contract seams
3. current signer-host topology
4. current image/build/release pipeline
5. current persistence topology
6. current S2S authentication model
7. current notification path
8. current execution/write-back path
9. current observability/health model
10. actual production deployment evidence
11. any external consumers already present
12. current entitlement/capability implementation

Then issue a fresh build directive against that substrate. Do not build from this backlog text alone.

---

## 8. Completion definition for the future increment

The future increment is complete only when the authorized target is proven, not merely configured.

For dedicated PROD, proof must include:

- E-Sign deploys independently from Aramo Core.
- `sign.aramo.ai` reaches the dedicated E-Sign environment.
- Core can execute the full signing flow across the service boundary.
- Source-document retrieval works across the service boundary.
- completion/write-back works across the service boundary.
- tenant isolation and service authentication are proven.
- independent health, logging, rollout, rollback and release evidence exists.

If subscription scope is also activated, additionally prove entitlement enforcement and usage metering without changing E-Sign domain transition authority.

---

## 9. Standing instruction to future Claude Code sessions

If a future implementation task touches E-Sign infrastructure, contracts, entitlements, or deployment, read the accompanying **E-Sign Standalone Service Architecture Intent** before making architecture changes.

If a proposed implementation conflicts with that intent, HALT and surface the conflict to the PO rather than silently normalizing the architecture around the current task.
