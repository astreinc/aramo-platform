# ADR-0009: Resolver-Region Allow-List Expansion for Audit-Event Read Paths

**Status:** Accepted

**Date:** 2026-05-01

**Supersedes:** none

**Extends:** ADR-0006 (Implementation Precedent O — allow-list contents); ADR-0008 (Decision A — twice-validated precedent extended with one new operation under a stated principle)

**Related PRs:** PR-7.0 (this ADR), PR-7 (forthcoming, blocked on this ADR)

**Related ADRs:** ADR-0001 through ADR-0008

---

## 1. Context

PR-7 scoping identified the consent decision-log read endpoint, which reads from `consentAuditEvent`. During PR-7's directive verification cycle, the verification surfaced that `tx.consentAuditEvent.findMany` is not in the resolver-region allow-list (`ALLOWED_RESOLVER_OPERATIONS`). The current allow-list, as enforced by `consent.refusal-r4.spec.ts`:

```
tx.idempotencyKey.findUnique
tx.idempotencyKey.create
tx.talentConsentEvent.findMany
tx.consentAuditEvent.create
```

`consentAuditEvent.create` is already present for the existing audited decision path; this ADR does not expand write authorization. `consentAuditEvent.findMany` is the read counterpart and is not present. PR-7 cannot execute without this addition.

ADR-0008 Decision A's constraint applies: "A method added to the resolver region that uses any operation outside `ALLOWED_RESOLVER_OPERATIONS` requires an explicit guardrail update and a new ADR. This precedent does not authorize silent expansion of the allow-list." This ADR is that explicit guardrail update.

The ADR is small in surface (one operation added) but load-bearing in principle. Without a stated principle, every future addition becomes ad-hoc: "PR-N needs operation X, so we add it." With a stated principle, future additions are evaluated against the principle rather than precedent-by-accumulation.

---

## 2. Scope

**In scope.**

- Adding `tx.consentAuditEvent.findMany` to `ALLOWED_RESOLVER_OPERATIONS`
- Stating the principle that justifies the addition
- Stating the forward constraint that bounds future allow-list expansions

**Out of scope.**

- Other operations on `consentAuditEvent` (e.g., `findFirst`, `findUnique`, `aggregate`) — not added by this ADR; additions require future ADRs evaluated against the principle stated here
- Operations on other tables (e.g., `outboxEvent`, `talentConsentEvent.findFirst`) — not authorized by this ADR; future additions require their own ADRs
- PR-7's directive itself (forthcoming after this ADR lands)
- Changes to the resolver-region marker mechanism (ADR-0006 Precedent O text) — the mechanism is unchanged; only the allow-list contents change

---

## 3. Decision

### Decision A — Allow-list expansion

**Statement.** Add `tx.consentAuditEvent.findMany` to `ALLOWED_RESOLVER_OPERATIONS` in `consent.refusal-r4.spec.ts`. The post-expansion allow-list:

```
tx.idempotencyKey.findUnique
tx.idempotencyKey.create
tx.talentConsentEvent.findMany
tx.consentAuditEvent.create
tx.consentAuditEvent.findMany    ← added
```

**Rationale.** PR-7's decision-log read endpoint reads paginated, ordered results from `consentAuditEvent` without staleness or enforcement semantics. The shape of the access (`findMany` with `where`, `orderBy`, `take`, cursor predicate) is identical to PR-6's `talentConsentEvent.findMany` access in `resolveHistory`. The two operations are semantic siblings: both are paginated reads from event/log tables in the resolver region, both serve read endpoints that produce universal projections (per ADR-0007 Decision C), and both inherit the no-decision-log-write rule (per ADR-0007 Decision H) — though the second is sharper for `consentAuditEvent` because the table being read is the very table the rule prohibits writing to.

**Implementation surface.**

- `libs/consent/src/tests/consent.refusal-r4.spec.ts` — `ALLOWED_RESOLVER_OPERATIONS` set, one entry added
- No changes to the marker mechanism, region splitting, or string-based enforcement
- R4 guardrail tests must pass after the addition; the addition is a relaxation of the guardrail's denial set, not a change to its enforcement logic

---

## 4. The principle (load-bearing)

The allow-list is not a free list. The expansion in §3 is justified by a principle, and that principle bounds future expansions.

### Principle: read paths against audit and event-log tables that produce paginated, ordered results without staleness or enforcement semantics are appropriate for the resolver region.

This principle has four explicit clauses, all of which must hold for an operation to qualify:

1. **Read path.** The operation reads data; it does not create, update, or delete. Write operations are not eligible for the resolver-region allow-list under this principle. (`create`, `update`, `delete`, `upsert`, `deleteMany`, `updateMany` are out.)

2. **Audit or event-log table.** The table is used as an event-log source in this module — recording events or audit entries that, by convention, are added but not modified or deleted. Tables with mutable rows in normal operation, computed state, or enforcement semantics are not eligible under this principle. (`talentConsentEvent` and `consentAuditEvent` qualify; tables that hold current-state projections, configuration, or user data do not.)

3. **Paginated, ordered results.** The operation returns multiple rows in a deterministic order with cursor-based pagination per ADR-0008 Decision B. Single-row reads (`findFirst`, `findUnique`) and unordered/aggregate operations (`count`, `aggregate`, `groupBy`) are not eligible under this principle.

4. **No staleness or enforcement semantics.** The operation produces records as historical truth, not as the basis for an enforcement decision. ADR-0007 Decision E's staleness boundary applies: enforcement metadata is computed at check time, never written into the records this operation returns.

An operation that satisfies all four clauses is eligible for resolver-region admission. An operation that fails any clause is not — adding it requires either a different principle (which itself requires an ADR) or rejection.

### What this principle authorizes (in this ADR)

- `tx.consentAuditEvent.findMany` (added in §3)
- `tx.talentConsentEvent.findMany` (already present, retroactively justified by this principle)

### What this principle does NOT authorize

- `tx.consentAuditEvent.findFirst` — fails clause 3 (single-row read)
- `tx.consentAuditEvent.aggregate` — fails clauses 3 and 4 (aggregate, possibly enforcement-adjacent)
- `tx.consentAuditEvent.count` — fails clause 3
- `tx.talentConsentEvent.findFirst` — fails clause 3 (and is intentionally write-region-only per existing precedent)
- `tx.outboxEvent.findMany` — would require principle application: is `outboxEvent` an audit/event-log table per clause 2? Probably yes. But this ADR does not pre-authorize; the next ADR proposing outbox reads must apply the principle explicitly.

---

## 5. Forward constraint

Future allow-list expansions must satisfy the principle in §4, and the application must be explicit.

**Required elements for any future allow-list expansion ADR:**

1. State the operation being added
2. Apply the §4 principle clause-by-clause; show which clauses are satisfied
3. If any clause is not satisfied, state the alternative principle being invoked and justify why it warrants resolver-region admission
4. Enumerate what the addition does NOT authorize (the negative space, as §4 does for this ADR)

**What this ADR explicitly forbids:**

- Adding an operation to the allow-list without an ADR
- Adding an operation under "PR-N needs it" justification alone without principle application
- Bundling multiple operations in a single addition without principle application for each
- Treating the allow-list as a default-allow with documented exceptions; it remains default-deny with documented authorizations

ADR-0008 Decision A's constraint ("This precedent does not authorize silent expansion of the allow-list") is reaffirmed and strengthened: expansion now also requires principle application, not just an ADR.

---

## 6. Surgical extensions to prior ADRs

### Extension to ADR-0006 (Implementation Precedent O)

ADR-0006 introduced Precedent O with the original allow-list of four operations. This ADR adds a fifth operation. The mechanism (string-based region splitting, marker comments, conservative over-inclusion) is unchanged. Only the contents change. ADR-0006's text is unchanged; this ADR's §3 is the addition.

### Extension to ADR-0008 (Decision A)

ADR-0008 Decision A established that allow-list expansions require an ADR. This ADR is the first such expansion and demonstrates the discipline. Decision A's text is unchanged; this ADR is its first invocation. The principle in §4 is a refinement: future expansions require not just an ADR but a principle application.

---

## 7. Consequences

**Positive.**

- PR-7 is unblocked. The decision-log read endpoint can use `findMany` against `consentAuditEvent` per the established cursor-pagination pattern.
- Future allow-list questions have a principle to apply, not just precedent to accumulate. "Does this operation belong in the resolver region?" becomes a checklist, not a debate.
- The discipline that ADR-0008 Decision A introduced (no silent expansion) is now load-tested by an actual expansion. The test passed: expansion happened with explicit ADR work, not by quiet edit.

**Costs / risks.**

- The four-clause principle is now load-bearing. If a future operation legitimately belongs in the resolver region but fails one of the four clauses, the principle may need to be relaxed — which itself requires an ADR. This is the intended cost.
- Adding the fifth operation makes the resolver-region surface visibly larger. The R4 guardrail spec will continue to enforce strict membership, but the cognitive overhead of "what's allowed in the resolver region" grows linearly with the allow-list size. This is acceptable but worth monitoring.

**Forward pointers.**

- PR-7 directive (re-authored against the correct `consentAuditEvent` schema model) cites this ADR for resolver-region authorization. Drafting begins after this ADR merges.
- Future ADRs proposing additional resolver-region operations apply §4's principle and §5's forward constraint. The principle's clauses may be tightened or extended based on cases that surface; tightening or extending requires an explicit ADR amendment.
- The principle in §4 may warrant naming in a future ADR if it sees multiple invocations. This ADR does not pre-name it; the name follows the pattern (named precedents come from twice-validated practice, not first-statement intent).

---

## 8. References

- **ADR-0006** — Implementation Precedent O (resolver-region marker mechanism + original allow-list)
- **ADR-0007 Decisions E, H, C** — staleness boundary, no-decision-log-write rule, universal-projection principle (the conceptual basis for §4's clauses 4, and the boundary that clause 4 reinforces)
- **ADR-0008 Decision A** — twice-validated precedent + the constraint that this ADR invokes
- **PR-6 implementation** (merged at `56cb652`; source commit `bbac751`) — `resolveHistory` as the canonical example of a resolver-region read against an event-log table; the pattern PR-7 will follow against `consentAuditEvent`
- **PR-7 directive verification report** — the verification cycle that surfaced the missing allow-list entry and triggered this ADR
- `libs/consent/src/tests/consent.refusal-r4.spec.ts` — the file modified by this ADR's implementation
