# Aramo Enterprise Maturity Register

**Document ID:** `Aramo-Enterprise-Maturity-Register`  
**Canonical repo path:** `doc/maturity/enterprise-maturity-register.md`  
**State:** ACTIVE GOVERNANCE REGISTER  
**Authority:** PO / Architect  
**Purpose:** Track known gaps between Aramo's currently authorized behavior and the behavior expected of a mature enterprise platform, without silently converting those gaps into implementation authority.

---

## 1. Register Role

This register is the canonical repository ledger for **enterprise maturity obligations**.

It exists to answer:

> What capabilities are intentionally safe-but-incomplete today, what mature enterprise behavior is eventually required, why was it deferred, and what future gate forces the program to reconsider it?

This is **not**:

- an implementation directive;
- a product backlog;
- a Jira replacement;
- a technical-debt list;
- authorization for Claude Code to implement future behavior;
- a substitute for LOCKED DDRs, directives, amendments, closure records, or Gate-5 / Gate-6 evidence.

An entry in this register identifies an obligation. Implementation still requires the normal Aramo governance path:

`Maturity obligation -> Recon -> Architect/PO ruling -> LOCKED DDR/directive -> Build -> Gate-5/Gate-6 -> exact-SHA merge -> closure update`

---

## 2. Source of Truth

The canonical register lives in the repository at:

`doc/maturity/enterprise-maturity-register.md`

Supporting systems may reference it, but do not replace it:

- **Repo:** canonical maturity register and status history.
- **OneDrive LOCKED artifacts:** detailed ratified architecture/design/directive authority.
- **GitHub/Jira:** implementation tracking.
- **ChatGPT / Claude memory:** coordination convenience only.
- **Dashboards/reports:** derived views only.

No external copy may silently supersede the repo register.

---

## 3. Maturity Status Model

Every maturity obligation MUST use exactly one of these states.

### `CURRENT`

The current implementation is considered the intended mature enterprise behavior for the defined scope.

### `SAFE-INTERMEDIATE`

The current implementation is intentionally narrower than the eventual enterprise target, but is safe to operate inside its documented boundary.

### `DEFERRED-MATURITY`

A known enterprise capability is missing or intentionally incomplete. The need is recorded, but architecture and/or implementation is not yet authorized.

### `DESIGN-LOCKED`

The enterprise target and governing design have been ratified in a LOCKED authority artifact, but implementation is not yet complete.

### `ENTERPRISE-CLOSED`

The mature capability is implemented and validated for the defined scope, including required security, contracts, auditability, operational behavior, tests, and release evidence.

---

## 4. Allowed Dispositions

A maturity obligation may leave the active register only through an explicit disposition:

- `IMPLEMENTED`
- `SUPERSEDED`
- `NOT-REQUIRED`
- `ACCEPTED-LIMITATION`

No maturity item may simply disappear.

Removal or closure MUST cite the governing Architect/PO decision and the merge/closure evidence that justified the disposition.

---

## 5. Required Fields

Every `EM-*` entry MUST contain:

- **ID**
- **Domain**
- **Title**
- **Status**
- **Current posture**
- **Enterprise target**
- **Why deferred / why intermediate**
- **Risk if never addressed**
- **Revisit gate**
- **Dependencies**
- **Owning track/domain**
- **Governing evidence**
- **Implementation authority**
- **Last disposition**
- **Notes**

Optional fields may be added when useful, but these required fields may not be removed.

---

## 6. Governance Rules

1. **Unique immutable IDs**  
   IDs use `EM-<DOMAIN>-NNN`. Once assigned, an ID is never reused.

2. **Register != authorization**  
   No entry authorizes implementation. `Implementation authority: NONE` is the default unless a separately ratified directive grants authority.

3. **No silent maturity claims**  
   A feature merge does not automatically mean `ENTERPRISE-CLOSED`.

4. **No silent deletion**  
   Open obligations remain visible until explicitly dispositioned.

5. **Hard revisit gates**  
   Every deferred item must state the event that forces reconsideration.

6. **Reference, do not duplicate**  
   Detailed architectural rules belong in LOCKED DDRs/directives. This register summarizes the obligation and links to governing evidence.

7. **Gate-6 maturity delta**  
   Every governed delivery closure should state:
   - maturity obligations created;
   - maturity obligations changed;
   - maturity obligations closed;
   - maturity obligations carried forward.

8. **PO / Architect ownership**  
   Claude Code may edit maturity posture only when explicitly instructed by an authorized governance artifact or PO/Architect instruction.

9. **No maturity laundering**  
   A safe intermediate implementation cannot be relabeled mature merely because it is stable, tested, or deployed.

10. **Merge != deploy**  
    Maturity closure and deployment authorization remain independent where the governing track requires separate deployment authority.

---

## 7. Enterprise Maturity Register

---

### EM-T8-001 — External Requisition Synchronization

**Domain:** VMS / Requisition Integration  
**Status:** `DEFERRED-MATURITY`

**Current posture:**  
T8-P2 supports provider-neutral requisition ingestion using a CREATE-only model. A first external identity `(tenant, source_system, external_req_id)` creates a requisition. Repeated use of the same external identity is rejected deterministically as a conflict and does not mutate the originally created requisition.

**Enterprise target:**  
Governed synchronization for existing external requisitions, including explicit handling of:

- CREATE;
- UPDATE;
- NO-OP;
- stale/out-of-order source events;
- conflicting changes;
- protected/immutable fields;
- source-vs-Aramo field ownership;
- version/effective-date semantics where required;
- reversible or compensating behavior;
- durable audit/change history.

**Why deferred / why intermediate:**  
T8-P2 intentionally did not define update-existing semantics because the existing reversible import model cannot safely reverse an in-place requisition mutation without a ratified prior-state/version/conflict model.

**Risk if never addressed:**  
Aramo would be able to ingest a VMS requisition once but could not safely maintain long-lived requisition changes from enterprise systems such as VMS/procurement platforms.

**Revisit gate:**  
MUST be dispositioned before production authorization of the first real VMS/provider connector that is expected to maintain requisitions over time.

**Dependencies:**

- T8-P1 external requisition identity substrate;
- T8-P2 provider-neutral CREATE-only import framework;
- governed audit/version history;
- source ownership/conflict semantics;
- reversible/compensating update design.

**Owning track/domain:** T8 — VMS Integration

**Governing evidence:**

- PR #606 — T8-P2;
- T8-P2 closure: `MERGED / CLOSED / NOT DEPLOYED`;
- future T8 synchronization Recon/DDR.

**Implementation authority:** `NONE`

**Last disposition:**  
T8-P2 closure retained update-existing as `DEFERRED / ARCHITECTURE-HALTED`; replay remains reject-only.

**Notes:**  
Do not implement `resolveByExternalIdentity`, `updateForImport`, `upsertForImport`, or equivalent mutation semantics merely to remove the conflict behavior. The synchronization contract must be designed first.

---

### EM-T8-002 — Production VMS / Provider Connector Layer

**Domain:** VMS / Requisition Integration  
**Status:** `DEFERRED-MATURITY`

**Current posture:**  
T8-P2 is provider-neutral and transport-neutral. It contains no production provider connector, credentials, polling, webhook transport, or provider-specific state.

**Enterprise target:**  
Production-grade provider connectivity with governed:

- connector lifecycle;
- credential/secret storage;
- authentication;
- polling and/or webhook transport;
- retry/backoff;
- idempotency;
- dead-letter/replay handling;
- observability;
- provider-specific mapping;
- operational ownership;
- security and tenant isolation.

**Why deferred / why intermediate:**  
T8-P2 deliberately established the canonical ingestion substrate before introducing external provider transport and secret-management failure modes.

**Risk if never addressed:**  
Aramo cannot operate a real automated enterprise VMS integration despite having an internal canonical import framework.

**Revisit gate:**  
Before authorization of `T8-CONNECTOR` production implementation or onboarding of the first real VMS integration tenant.

**Dependencies:**

- T8-P2;
- connector/security architecture;
- credential vault posture;
- EM-T8-001 disposition where ongoing requisition updates are required.

**Owning track/domain:** T8 — VMS Integration

**Governing evidence:**

- PR #606;
- T8-P2 closure.

**Implementation authority:** `NONE`

**Last disposition:**  
`T8-CONNECTOR` remains separately unauthorized.

**Notes:**  
Do not smuggle a provider-specific connector into UI or import-framework increments.

---

### EM-GLH-001 — Governed API Contract Parity Beyond Method + Path

**Domain:** API / CI / Contract Governance  
**Status:** `DEFERRED-MATURITY`

**Current posture:**  
GLH-1-C enforces governed live-route/OpenAPI parity at method-and-path level. The initial ratified `transitionalUndocumented` debt snapshot is 169 governed operations. New governed-undocumented routes fail unless explicitly approved into the debt set. No XD/intentionally-undocumented escape class exists.

**Enterprise target:**  
Deeper governed parity covering the dimensions required for enterprise API correctness, including:

- authentication/security schemes;
- scopes/authorization;
- request schemas;
- response schemas;
- error contracts;
- content types;
- other contract dimensions explicitly ratified by future GLH increments.

**Why deferred / why intermediate:**  
GLH-1-C intentionally established the first enforceable GA parity wall at method-and-path granularity. Deeper parity was explicitly deferred to future hardening.

**Risk if never addressed:**  
A route may exist in both runtime and OpenAPI while security, schema, error, or content-type behavior still drifts.

**Revisit gate:**  
Before the relevant future GLH hardening/GA contract-completeness gate.

**Dependencies:**

- GLH-1-C contract-parity wall;
- future GLH-2..5 Architect authorization.

**Owning track/domain:** GLH — CI / Contract Integrity

**Governing evidence:**

- PR #607;
- merge commit `4b827f41919d0290dbcdfabc8b26571a5ef87370`;
- GLH-1-C closure.

**Implementation authority:** `NONE`

**Last disposition:**  
GLH-1-C = `MERGED / CLOSED / NOT DEPLOYED`; deeper parity remains future hardening.

**Notes:**  
The 169-entry debt snapshot is separate contract debt governed by the GLH-1-C ratchet. This maturity item does not replace that debt ledger.

---

### EM-T5-001 — Assignment Commercial Revision / Supersession Lifecycle

**Domain:** Assignment / Commercial Terms  
**Status:** `DEFERRED-MATURITY`

**Current posture:**  
The current Track-5 commercial model establishes initial/effective assignment commercial terms and a read projection. The later lifecycle for revision, supersession, future version creation, overlap repair, and effective-date transitions is intentionally outside the current read increment.

**Enterprise target:**  
Governed effective-dated commercial-term lifecycle supporting safe commercial revisions and supersession while preserving auditability, deterministic effective-version resolution, and historical correctness.

**Why deferred / why intermediate:**  
The read/projection increment deliberately does not own mutation or supersession semantics. Those behaviors require a separately authorized lifecycle design.

**Risk if never addressed:**  
Commercial terms could be created/read but not safely revised as real assignments change over time.

**Revisit gate:**  
Before any production workflow requires assignment-rate revision/supersession after initial assignment creation.

**Dependencies:**

- initial `AssignmentRateVersion` substrate;
- canonical commercial projection;
- canonical `deriveCommercialMetrics(...)`;
- future lifecycle/versioning authority.

**Owning track/domain:** Assignment commercial lifecycle / future authorized track

**Governing evidence:**

- T5-P1 closure;
- T5-P2 governing handover state;
- future authorized lifecycle DDR/directive.

**Implementation authority:** `NONE`

**Last disposition:**  
Revision writes, overlap repair, supersession, future version creation, and `effective_to` mutation remain separately unauthorized.

**Notes:**  
Do not infer update authority from commercial read/write scope names alone.

---

### EM-PLATFORM-001 — Multi-Host Production Auth Base Derivation

**Domain:** Platform Console / Authentication / Routing  
**Status:** `DEFERRED-MATURITY`

**Current posture:**  
Per-consumer redirect derivation exists, but the known production multi-host topology requires host-derived auth-public-base behavior before a separate platform-web origin can be safely released across tenant and platform hosts.

**Enterprise target:**  
Production-safe host-aware authentication base/redirect derivation for concurrent tenant and platform console hostnames without relying on one shared static environment base.

**Why deferred / why intermediate:**  
The platform console architecture separated the platform app/origin, exposing the limitation of a single auth-public-base environment value.

**Risk if never addressed:**  
Authentication redirects/cookies/origin behavior may be incorrect when tenant subdomains and a separate platform-admin hostname operate concurrently.

**Revisit gate:**  
Before production deployment of platform-web on its separate production hostname.

**Dependencies:**

- platform-console Increment-1 auth redirect work;
- platform-web app architecture ruling;
- production hostname/routing topology.

**Owning track/domain:** Platform Console / Auth Hardening

**Governing evidence:**

- Platform Console Increment-1 Closure Record;
- Platform-Web App Architecture ruling instrument.

**Implementation authority:** `NONE`

**Last disposition:**  
Known production-gating follow-up; not part of Increment-1 closure.

**Notes:**  
Local-dev success does not close the production multi-host maturity obligation.

---

## 8. Domain Summary

| Domain | Item | Status | Revisit Gate |
|---|---|---|---|
| VMS Integration | EM-T8-001 External requisition synchronization | DEFERRED-MATURITY | Before first production connector requiring ongoing updates |
| VMS Integration | EM-T8-002 Provider connector layer | DEFERRED-MATURITY | Before T8-CONNECTOR production authorization |
| API / Contract Governance | EM-GLH-001 Deep API parity | DEFERRED-MATURITY | Future GLH hardening / GA contract gate |
| Assignment Commercials | EM-T5-001 Commercial revision lifecycle | DEFERRED-MATURITY | Before production rate-revision workflow |
| Platform/Auth | EM-PLATFORM-001 Multi-host auth derivation | DEFERRED-MATURITY | Before platform-web production deployment |

---

## 9. Gate-6 Maturity Delta Template

Every applicable Gate-6 return should include:

```text
Enterprise Maturity Delta

Created:
- <EM-ID or none>

Changed:
- <EM-ID: old-state -> new-state or none>

Closed:
- <EM-ID + disposition + evidence or none>

Carried:
- <EM-ID or none>

New maturity blockers:
- <description or none>
```

If an implementation introduces a known safe intermediate behavior and no existing `EM-*` item captures it, the Gate-6 return MUST flag that fact for Architect disposition.

---

## 10. New Entry Template

```markdown
### EM-<DOMAIN>-NNN — <Title>

**Domain:** <domain>  
**Status:** `DEFERRED-MATURITY`

**Current posture:**  
<What Aramo does today.>

**Enterprise target:**  
<What mature enterprise behavior eventually requires.>

**Why deferred / why intermediate:**  
<Why the target was not implemented now.>

**Risk if never addressed:**  
<Business, security, operational, compliance, integration, or correctness risk.>

**Revisit gate:**  
<Specific future event that forces reconsideration.>

**Dependencies:**

- <dependency>

**Owning track/domain:** <track/domain>

**Governing evidence:**

- <PR / closure / DDR / directive / amendment>

**Implementation authority:** `NONE`

**Last disposition:**  
<Latest PO/Architect decision.>

**Notes:**  
<Important constraints / prohibitions / context.>
```

---

## 11. Change Discipline

When this file changes:

1. preserve existing `EM-*` IDs;
2. do not delete unresolved obligations;
3. explain every status change;
4. cite governing evidence;
5. do not create implementation authority;
6. keep detailed architecture in its governing artifact;
7. update the Domain Summary;
8. include the register delta in the relevant Gate-6/closure record.

A future CI validator may enforce structural rules such as unique IDs, allowed states, mandatory revisit gates, and explicit closure dispositions. Until such a validator is separately authorized, this file is review-governed rather than machine-enforced.

---

*End of Aramo Enterprise Maturity Register.*
