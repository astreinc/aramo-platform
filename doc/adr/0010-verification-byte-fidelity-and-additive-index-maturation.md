# ADR-0010: Verification, Byte-Fidelity, and Additive Index Maturation

**Status:** Accepted

**Date:** 2026-05-01

**Supersedes:** none

**Extends:** ADR-0007 (§7 verify-before-drafting — extended with vocabulary check); ADR-0008 (Decision E Path A-equivalent — extended with corruption-recovery protocol; Decision G Precedent P — empirical-validation note)

**Related PRs:** PR-7 (merged at `896495a` via PR #21; source commit `e86ad53`), PR-7.1 (this ADR)

**Related ADRs:** ADR-0001 through ADR-0009

---

## 1. Context

ADR-0008 codified the methodology disciplines that produced the PR-5 → PR-6.1 arc. ADR-0009 added an architectural amendment to unblock PR-7. PR-7 then executed cleanly using inheritance from the codified discipline, completing the arc:

```
PR-5 → PR-5.1 → PR-6 → PR-6.1 → PR-7.0 → PR-7
```

Six consecutive first-push-green PRs across two artifact classes (implementation PRs and ADR PRs). The streak is not the only signal worth codifying. During the arc, three concrete refinements to the codified methodology surfaced empirically, each load-tested under real conditions:

1. **Vocabulary check at verify-before-drafting tier.** ADR-0009 setup caught locked-vocabulary violations in Lead-authored ADR text — caught at the setup gate, one round-trip later than ideal. Adding `bash scripts/verify-vocabulary.sh` to the verify-before-drafting checklist would have caught it one round-trip earlier, at the verification cycle stage.

2. **Path A-equivalent byte-fidelity validation under real corruption.** PR-7.0's commit message authoring caught real paste-pipeline corruption (line breaks stripped) at the `xxd` byte-verification step before the file landed on disk. The chain held: detect, halt-and-report (not auto-reconstruct), Lead re-supplied bytes, retry verified clean. ADR-0008 Decision E's framing was speculative at authoring; PR-7.0 made it empirical.

3. **Schema-only additive index pattern.** PR-6 added a keyset index to `talentConsentEvent` without an explicit migration file; PR-7 added a keyset index to `consentAuditEvent` under the same pattern. Two consecutive applications across distinct tables establishes the pattern as twice-validated standing practice, applicable only to additive indexes (not destructive schema changes, column changes, enum changes, or data migrations).

Each refinement is small, concrete, and grounded in actual usage rather than speculative design. ADR-0007 §7's "no speculative design" constraint applies; this ADR codifies reality, not intent.

This ADR is a maturation pass on ADR-0007 and ADR-0008's methodology, not a new methodology codification. It refines disciplines already in force based on what their first cycles taught.

---

## 2. Scope

**In scope.** Three refinements from the PR-5 → PR-7 arc:

1. Vocabulary check added to verify-before-drafting cycle
2. Path A-equivalent corruption-recovery protocol codified
3. Schema-only additive index pattern as twice-validated standing practice

**Out of scope.**

- Forward-looking ADR naming convention (PR-7.0 was the first instance; needs a second forward-looking ADR before twice-validation per the program's named-precedent rule)
- R4 guardrail comment hygiene (Lead disposition was leave-as-is; codifying the disposition itself is overkill)
- New methodology disciplines beyond refinements to ADR-0007 / ADR-0008
- Modifications to ADR-0001 through ADR-0009

---

## 3. Decisions

### Decision A — Vocabulary check at verify-before-drafting tier

**Statement.** The verify-before-drafting cycle (ADR-0007 §7) is extended to include `bash scripts/verify-vocabulary.sh` as a checklist item. The check runs against the artifact under verification (ADR or directive) before the verification report is produced.

**Rationale.** ADR-0009's setup gate caught four locked-vocabulary violations in Lead-authored text — uses of `candidate` and `evaluation`, since reworded to `eligible` and `principle application` per the merged ADR. The catch was correct but late: the violations had already passed through the verify-before-drafting cycle without being flagged. Verify-before-drafting was checking citations, structural correctness, and schema references, but not vocabulary compliance. Adding the vocabulary check moves detection one round-trip earlier — Lead disposes the rewordings during the verification cycle's amendment loop instead of during the setup gate.

The check is mechanical (no judgment required), fast (the existing script runs in under 30 seconds), and the failure mode is concrete (specific line numbers with specific terms). It belongs in the same checklist as the structural verifications.

**Implementation surface.**

- Verify-before-drafting cycle (ADR or directive tier) now includes:
  1. Citation verification (artifact references resolve to real artifacts on `main`)
  2. Structural verification (schema references match `main`, file paths exist, etc.)
  3. **Vocabulary verification (`bash scripts/verify-vocabulary.sh`) — added by this ADR**
  4. Verification report in Verified / Mismatches / Ambiguities format
- Future ADR setup cycles do not skip the vocabulary check at the setup gate; the verify-before-drafting addition is in addition to, not instead of, the setup-gate check

**Constraint.** The vocabulary check is non-bypassable. A verify-before-drafting cycle that returns "clean" while the artifact contains unflagged vocabulary violations is a discipline failure, not an acceptable optimization.

### Decision B — Path A-equivalent corruption-recovery protocol

**Statement.** When Path A-equivalent (per ADR-0008 Decision E) detects corruption during byte-fidelity verification, the recovery protocol is:

1. **Detect.** `xxd` byte-check (or equivalent) against the source bytes after Write tool produces the on-disk file.
2. **Halt.** No commit. No push. No auto-reconstruction.
3. **Surface.** Report the specific corruption (missing bytes, replaced characters, encoding artifacts) to Lead with the on-disk artifact preserved for inspection.
4. **Retry via safer path.** Lead re-supplies bytes (Path A-equivalent retry) or escalates to Path A direct (Lead-authored heredocs on the canonical machine).

The protocol is **detect → halt → do not reconstruct → retry**. Auto-reconstruction is prohibited because reconstruction inverts the discipline: the agent becomes the byte-source instead of the verifier.

**Rationale.** PR-7.0's first commit-message authoring attempt produced bytes with line breaks stripped during chat transmission. The `xxd` byte-check at step 2 of the Path A-equivalent chain caught the corruption before the file landed on disk for `git commit`. Lead re-supplied bytes with line breaks intact; retry verified clean. Total cost: one round-trip. Without the chain, the corrupted commit message would have committed and surfaced as either a malformed commit body or a downstream bug detected far later.

The chain's load-bearing property is the **halt** step. An agent that detects corruption and tries to "fix" it by reconstructing the missing bytes from context defeats the purpose of byte-fidelity verification. The agent is not authorized to author bytes for the artifact class; detection is its only role.

**Implementation surface.**

- Path A-equivalent flow (commit messages, PR bodies):
  1. Lead supplies bytes
  2. Agent writes to `/tmp` via Write tool
  3. Agent runs `xxd` or equivalent byte-check against source
  4. **If clean:** proceed to consume via `-F` / `--body-file`
  5. **If corrupted:** halt, surface specific corruption to Lead, do not modify the on-disk artifact, await Lead retry

- The PR-7.0 implementation report is the canonical example of the chain catching corruption and recovering cleanly.

**Constraint.** Reconstruction is prohibited regardless of how obvious the original bytes appear from context. "I can see what the missing line break should be" is not authorization to add it. The agent's role is detect-and-report, not author-and-correct.

### Decision C — Schema-only additive index pattern

**Statement.** Additive indexes on existing tables may be added to Prisma schema without a separate migration file. Production migration is handled at deploy time via the standard Prisma migration workflow (`prisma migrate dev` / `prisma migrate deploy`). The pattern applies **only** to additive changes that do not break existing schema contracts.

**Eligible under this pattern:**

- Adding a new `@@index([...])` declaration on an existing table
- Adding a new optional column with a default value (provided no application code requires the column to exist before deploy)

**NOT eligible under this pattern (require explicit migration files):**

- Destructive schema changes (`@@drop`, column removal, table removal)
- Column type changes
- Enum value additions, removals, or renames
- Required-column additions (would break existing rows)
- Data migrations of any kind
- Foreign key constraint changes
- Schema renames

**Rationale.** PR-6 added `@@index([tenant_id, talent_id, created_at(sort: Desc), id(sort: Desc)])` on `talentConsentEvent` to support PR-6's keyset pagination. The PR's Prisma schema change passed `prisma:validate`; integration tests passed at the testcontainer without the index physically applied (the index improves production performance but doesn't change correctness for ordered scans on small test data). PR-7 added `@@index([tenant_id, subject_id, created_at(sort: Desc), id(sort: Desc)])` on `consentAuditEvent` under the same pattern. Both PRs landed first-push-green. Both deferred actual index creation to deploy-time migration tooling.

The pattern is twice-validated and the tradeoff is explicit: simpler PR shape (no migration file authoring) for additive indexes, in exchange for deploy-time discipline (the migration step actually runs at deploy). Restricting the pattern to additive-only ensures the deploy-time step cannot break running systems — additive indexes are non-destructive by definition.

**Implementation surface.**

- PR-6: `libs/consent/prisma/schema.prisma` — `talentConsentEvent` keyset index (merged at `56cb652`)
- PR-7: `libs/consent/prisma/schema.prisma` — `consentAuditEvent` keyset index (merged at `896495a` via PR #21)
- Both PRs documented the deferred migration in their respective implementation reports under "What was NOT done"
- Future additive indexes follow this pattern; future destructive or non-additive schema changes require explicit migration files per the eligibility list above

**Constraint.** The eligibility list is closed. A schema change that doesn't appear in the eligible list is not eligible by default. Adding a new eligibility category requires an ADR amendment. Treating the pattern as "additive-by-judgment" is a discipline failure; the list above is the discipline.

---

## 4. Surgical extensions to prior ADRs

### Extension to ADR-0007 §7 (verify-before-drafting)

ADR-0007 §7 codified the verify-before-drafting cycle for ADR documents and (via ADR-0008 Decision C) directive documents. Decision A of this ADR adds the vocabulary check as a non-bypassable step in the cycle. The cycle's shape (review → mismatches/ambiguities → amendments → re-verify clean → execute) is unchanged. Only the verification scope expands.

ADR-0007 §7's text is unchanged; this ADR's Decision A is the extension.

### Extension to ADR-0008 Decision E (Path A-equivalent)

ADR-0008 Decision E codified Path A-equivalent as authorized for commit messages and PR bodies, with byte-fidelity guarantees via Write-to-disk + `xxd` verification + `-F`/`--body-file` consumption. Decision B of this ADR codifies the corruption-recovery protocol for the case ADR-0008 didn't explicitly address: what happens when verification *catches* corruption.

ADR-0008 Decision E's text is unchanged; this ADR's Decision B is the extension.

### Extension to ADR-0008 Decision G (Precedent P)

ADR-0008 Decision G promoted Precedent P to "load-bearing pre-commit gate" after three consecutive first-push-green PRs. Six consecutive first-push-green PRs (PR-5, PR-5.1, PR-6, PR-6.1, PR-7.0, PR-7) further validate the gate as a system property, not just a discipline. The streak holds across both implementation PRs and ADR PRs, which is the meaningful signal — the gate works regardless of artifact class.

ADR-0008 Decision G's text is unchanged; this is an empirical-validation note. No further codification is required at this point; the framing in ADR-0008 already names what's now empirically true.

---

## 5. Consequences

**Positive.**

- The verify-before-drafting cycle now catches one more class of issues (locked-vocabulary violations) one round-trip earlier than the setup gate would.
- The Path A-equivalent corruption-recovery protocol is documented as detect-halt-no-reconstruct-retry, removing ambiguity about agent authority during corruption events.
- The schema-only additive index pattern is bounded to a closed eligibility list, preventing the pattern from drifting into destructive-change territory.
- Six-PR first-push-green streak is on the record; future PRs that break the streak are diagnostic events rather than statistical noise.

**Costs / risks.**

- The vocabulary-check addition adds ~30 seconds to each verify-before-drafting cycle. This is a small fixed cost in exchange for one fewer round-trip on vocabulary failures.
- The corruption-recovery protocol's "no reconstruction" rule means a Lead must re-supply bytes for every corruption event, even if the missing bytes are obvious from context. This is the intended cost — reconstruction would invert the discipline.
- The schema-only additive index pattern's eligibility list is closed; expanding it requires explicit ADR work. Future contributors who want the convenience for non-additive changes will hit friction. This is also intended.

**Forward pointers.**

- A future forward-looking ADR (the second instance after PR-7.0/ADR-0009) will trigger codification of the forward-looking ADR naming convention. This ADR does not pre-codify; one instance is first-statement.
- The R4 guardrail comment block hygiene question (raised during PR-7 implementation) is deferred indefinitely. If a uniform-treatment cleanup PR happens, that PR's retroactive ADR can codify.
- Future PRs that break the first-push-green streak should be examined for whether the Precedent P sweep was skipped or whether new gate categories were added without local coverage. The gate's continued effectiveness depends on the local sweep matching the CI gate set.

---

## 6. References

- **ADR-0006** — Implementation Precedent O (resolver-region foundation referenced by §3 Decision C's twice-validated framing)
- **ADR-0007 §7** — verify-before-drafting cycle (extended by Decision A)
- **ADR-0008** — Decisions C (verify-before-authoring at directive tier), E (Path A-equivalent — extended by Decision B), G (Precedent P load-bearing gate — empirical validation note)
- **ADR-0009** — first allow-list expansion ADR; setup gate caught the vocabulary violations that motivated Decision A
- **PR-6 implementation** (merged at `56cb652`; source commit `bbac751`) — first instance of the schema-only additive index pattern (Decision C)
- **PR-7.0 implementation** (merged at `73f1520`; source commit `6f68a57`) — first instance of Path A-equivalent corruption-recovery (Decision B)
- **PR-7 implementation** (merged at `896495a` via PR #21; source commit `e86ad53`) — second instance of the schema-only additive index pattern (Decision C); first instance of vocabulary-check setup-gate catch (Decision A motivation)
