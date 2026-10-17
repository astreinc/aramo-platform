# ARAMO — Talent Erasure Request & Approval Workflow

**Directive ID:** ARAMO-PRIV-ERASURE-REQUEST-1  
**Version:** 1.0 — BACKLOG DRAFT  
**Status:** BACKLOG — NOT LOCKED  
**Priority:** High — Privacy Operations / Production Readiness  
**Target:** Aramo Talent Privacy Management  
**Dependencies:** S2 Talent Erasure Integrity, Talent Core, Identity, Consent, Audit and Retention

---

## 1. Objective

Establish a secure, auditable, end-to-end workflow through which a Talent can request erasure of personal information and an authorized privacy operator can review, approve, reject or defer that request.

Approved requests must be capable of invoking the existing S2 Talent Erasure engine through a controlled, authenticated backend execution path.

**The objective is to operationalize S2, not replace or duplicate it.**

## 2. Current Architecture Baseline

The existing S2 implementation provides:

- An operator-controlled `erase-talent` CLI.
- Tenant- and subject-bound erasure controls.
- Database and storage erasure processing.
- Legal and classification blockers.
- Durable execution and retry states.
- Audit and failure reporting.
- Protection against unauthorized or incomplete erasure.

The following business capabilities are not established as implemented:

- Talent-facing self-service erasure requests.
- A governed internal privacy request inbox.
- Identity verification and request authorization workflow.
- Human review and approval interface.
- An approved request-to-S2 execution integration.
- Talent-facing erasure status notifications.

The new workflow must reuse the authoritative S2 erasure lifecycle and must not create a second deletion engine.

## 3. Product Scope

### 3.1 Talent request intake

Provide an authenticated self-service experience where an eligible Talent can:

- Request erasure of personal information.
- Review an explanation of the consequences.
- Submit and confirm the request.
- Receive a reference number.
- View request status.
- Withdraw a pending request where policy permits.
- Receive a final outcome notification.

Support a separately governed request channel for individuals who cannot access the Talent Portal, including former users and people without an active account.

An unauthenticated request must not itself authorize erasure.

### 3.2 Identity verification

Before approval or execution:

- Verify the requester's identity using an authorized process.
- Establish the correct canonical Talent identity.
- Resolve duplicate or linked Talent records under existing identity authority.
- Resolve the applicable tenant and data-control responsibility.
- Prevent unauthorized requests against another Talent.

Do not infer identity solely from an email or phone number.

Never execute erasure when identity or authority is unresolved.

### 3.3 Privacy operations workspace

Provide an authorized privacy administration workflow.

An authorized privacy reviewer must be able to:

- View pending requests.
- Review identity-verification results.
- Inspect permitted retention and legal-hold indicators.
- Request additional information.
- Approve, reject or defer requests with reasons.
- Review S2 preflight findings.
- Monitor execution, blockers and outstanding storage obligations.
- Access the auditable request and decision history.

Do not grant this capability implicitly to recruiters, recruiting managers or ordinary tenant administrators.

Use domain-owned authorization scopes and the existing identity architecture. Exact roles and grants require reconciliation before implementation.

### 3.4 Approval and controlled execution

The workflow must distinguish:

1. A Talent's request.
2. Identity verification.
3. Privacy/legal eligibility review.
4. Authorized approval.
5. S2 execution authorization.
6. Execution outcome.

Approval must not bypass S2's database confinement, retention controls or object-storage requirements.

A verified approval must bind to the exact request, tenant, canonical Talent subject, authorized operation and approving actor.

The new backend execution mechanism must reuse the S2 engine and its existing confinement controls.

The operator CLI may remain available as a separately governed operational channel.

**No direct frontend invocation of `erase-talent`, database privilege escalation or generic trigger bypass is permitted.**

Initial implementation should require explicit human approval and controlled execution. Autonomous approval or direct self-service deletion is outside this directive.

## 4. Proposed Request Lifecycle

The request workflow should use business-level states distinct from the existing S2 execution states.

| State | Meaning |
|---|---|
| SUBMITTED | Request received |
| VERIFICATION_PENDING | Identity or ownership verification required |
| UNDER_REVIEW | Privacy review in progress |
| INFORMATION_REQUIRED | Additional information needed |
| APPROVED | Authorized decision recorded; execution not necessarily started |
| REJECTED | Request declined with an auditable reason |
| WITHDRAWN | Request withdrawn where permitted |
| EXECUTION_PENDING | Approved request awaiting controlled execution |
| EXECUTING | S2 execution started |
| BLOCKED | Legal, classification or technical blocker requires action |
| COMPLETED | All required S2 completion obligations satisfied |
| FAILED | Execution failed and requires authorized recovery |

These are proposed workflow states, not instructions to rename S2's existing internal states.

Define explicit transitions, actors, idempotency and retry semantics before implementation.

`APPROVED` must never be represented as `COMPLETED`.

## 5. S2 Integration Contract

The new workflow must invoke S2 through an authenticated, service-owned execution boundary with explicit authorization.

Required properties:

- Verified approval and authoritative request identity.
- Exact tenant and canonical Talent binding.
- Idempotent execution and duplicate-request handling.
- Durable correlation between privacy request and S2 erasure run.
- Fail-closed authorization, legal holds and retention handling.
- Truthful representation of S2 states including storage-pending, classification-pending and failure outcomes.
- Controlled retry after blocker resolution.
- No false completion or loss of execution history.
- No modification of S2's existing protected deletion semantics without a separately approved amendment.

Evaluate whether S2 should expose a narrowly scoped internal application service, job or operator gateway. Select the least-privileged design after examining the landed implementation.

Do not create a general-purpose deletion API.

## 6. Privacy, Consent and Retention

A request for erasure does not itself override:

- Legal holds.
- Mandatory record retention.
- Existing contractual obligations.
- Commercial and e-signature record classifications.
- Tenant boundaries.
- Immutable audit protections.
- Object-storage deletion requirements.

Preserve the ratified S2 classifications and unresolved blockers.

Request metadata, verification evidence and decision records must have a separately approved retention policy.

Notifications must not disclose sensitive screening, recruiting, commercial or internal security details.

Any statutory timing and notification requirements must be determined by applicable Legal authority, not hard-coded assumptions.

## 7. Audit and Security

Record a complete, tamper-evident history of:

- Request receipt and source.
- Verification outcome.
- Reviewer assignment and decisions.
- Approval identity and timestamps.
- Authorization to execute.
- S2 execution correlation.
- Blockers, retries, failures and completion.
- Notifications and delivery outcomes.

Enforce separation of duties as required by the privacy operating model.

Prevent an untrusted actor from manufacturing an approval or an executable erasure run.

Apply existing audit, tenant-isolation, sensitive-data minimization and access-control standards.

## 8. User Experience

### Talent Portal

Provide a privacy-management section supporting:

- Request personal-information erasure.
- Review request consequences.
- Confirm request.
- Track status.
- Obtain support or submit additional required information.

Do not expose internal S2 table names, error codes or security details.

### Internal Privacy Workspace

Provide a restricted request-management experience with:

- Request queue and aging.
- Identity-verification status.
- Retention and legal blockers.
- Decision recording.
- Execution status.
- Recovery and escalation actions.
- Audit history.

Use existing Aramo design systems and application architecture.

The UX must distinguish a request, an approval and a completed erasure.

## 9. Required Architecture Reconciliation

Before implementation, Claude Code must inspect:

1. The landed S2 domain, CLI, transaction and object-storage contracts.
2. Existing Talent Portal capabilities and identity verification.
3. Tenant administration and available privacy-related roles/scopes.
4. Consent, retention, audit and legal-hold mechanisms.
5. Current S2 production role separation and operator authentication requirements.
6. Existing notification infrastructure.
7. Applicable LOCKED authorities, including S2, ADR-0007 and TR-15.

Resolve the appropriate workflow owner, state model, API boundaries, authorization and execution mechanism.

Reuse existing capabilities rather than creating parallel systems.

## 10. Minimum Acceptance Criteria

The delivery is complete only when:

- A Talent can submit a request through an authorized supported channel.
- Identity and entitlement are verified before approval.
- An authorized reviewer can approve or reject the request.
- Unauthorized actors cannot approve or execute erasure.
- Approval is auditable and bound to the correct Talent and tenant.
- An approved request can initiate the existing S2 engine through the controlled execution boundary.
- Duplicate requests and retries do not cause unintended deletion.
- S2 blockers remain enforced.
- Storage-pending or failed execution cannot appear completed.
- The Talent can obtain an appropriate request outcome.
- Other Talents and tenants remain unaffected.
- Negative controls prove that bypassing verification, approval, tenant confinement or retention protections fails.
- The required privacy, integration, Pact and repository verification passes.

## 11. Explicitly Out of Scope

- Rebuilding S2.
- AI-autonomous approval of erasure.
- Recruiter-initiated unrestricted deletion.
- General-purpose hard-delete APIs.
- Automatic deletion solely because a Talent clicks a button.
- Removal of legal holds or business retention obligations.
- Modifying commercial retention classifications without Legal approval.
- Broad database trigger or privilege bypasses.
- Changes to Talent Trust assessment, Technical Screening judgments or Talent-selection logic.

## 12. Dependencies and Delivery Governance

This directive is a backlog architecture and product requirement, not authorization to implement or deploy.

Implementation requires reconciliation with the effective LOCKED architecture and approval of the execution and access-control design.

Production activation additionally depends on:

- A least-privileged database runtime and separately controlled erasure operator.
- Completed applicable Legal and retention decisions.
- Required S3 IAM capabilities.
- Authorized production deployment.
- Verified S2 readiness.

## 13. Proposed Delivery Structure

Organize implementation into the smallest practical increments:

**PR-1 — Request Domain and Identity:** request persistence, verification, authorization and auditable lifecycle.

**PR-2 — Review and Decision Workflow:** restricted privacy administration, decisions, blockers and notifications.

**PR-3 — S2 Execution Integration:** authenticated approval-to-execution handoff, correlation, retries and security negative controls.

**PR-4 — Talent Portal UX and End-to-End Verification:** request intake, status, integration and acceptance coverage.

These are planning packages, not mandatory separate GitHub PRs. Claude Code should consolidate them where safe and efficient.

---

**BACKLOG DISPOSITION:**

Retain as a future product capability.

Do not begin implementation until the PO authorizes activation of this backlog item and the Architect approves the reconciled execution design.

**Architectural principle:** Talent self-service initiates a privacy request; authorized human review determines whether erasure may proceed; the existing S2 engine performs the governed execution.
