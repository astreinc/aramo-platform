# Architecture Decision Records

This folder holds the Aramo program's Architecture Decision Records (ADRs). An ADR captures a decision whose rationale must survive Claude Code instance turnover and Lead Engineer rotation. Per `doc/04-risks.md` CX2 (Architectural rationale forgotten), ADRs are the named mitigation mechanism: Charter, Group 2 Baseline, Architecture v2.0, and API Contracts v1.0 preserve the long-term locked specifications, but day-to-day implementation choices that are *consequential but not locked* live here.

## Format

Every ADR in this folder uses the **Michael Nygard short-ADR template**. Each ADR file declares the following sections:

1. **Title** — `ADR-NNNN: <short subject>`
2. **Status** — one of `Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-NNNN`
3. **Date** — ISO-8601 date the status was last set
4. **Context** — what forces are at play; what makes this decision necessary
5. **Decision** — what was actually chosen, in the active voice
6. **Consequences** — Positive, Negative, and Neutral consequences of the decision

ADRs are append-only in spirit: when a decision is revisited, write a new ADR that supersedes the old one and update the older ADR's `Status` to `Superseded by ADR-NNNN`. Do not retroactively edit the Decision section of an Accepted ADR.

## Index

| ID | Title | Status | Date |
|---|---|---|---|
| [0001](0001-pr1-precedent-decisions.md) | PR-1 Precedent Decisions | Accepted | 2026-04-28 |
| [0002](0002-bootstrap-branch-protection-relaxations.md) | Bootstrap-Phase Branch Protection Relaxations | Accepted | 2026-04-28 |
| [0003](0003-infrastructure-conventions-prisma7-build-ci.md) | Infrastructure Conventions (Prisma 7 + Build/CI Patterns) | Accepted | 2026-04-30 |
| [0004](0004-pact-contract-test-convention.md) | Pact Contract Test Convention | Accepted | 2026-04-30 |
| [0005](0005-consent-revoke-contract-and-audit-semantics.md) | Consent Revoke Contract & Audit Semantics | Accepted | 2026-04-30 |
| [0006](0006-consent-check-contract-and-resolver-path-conventions.md) | Consent Check Contract & Resolver Path Conventions | Accepted | 2026-05-01 |

## When to write an ADR

Write an ADR when **all** of the following hold:

- A decision is being made (or has recently been made) that future contributors or future Claude Code instances would need to re-decide if the rationale is lost.
- The decision is **not** already locked in Charter, Group 2 Consolidated Baseline v2.0, Architecture v2.0, API Contracts v1.0, or the Phase 1 Delivery Plan v1.1. Locked specs are the source of truth for what they cover; ADRs do not duplicate or re-state them.
- The decision shapes program behavior beyond a single PR (tooling pins, enforcement mechanisms, generation strategies, deferred-strict rule lists, file-layout conventions, branching strategy, etc.).

If the decision satisfies all three, write an ADR before or alongside the PR that implements it. For Tier 3 PRs (per `doc/06-lead-review-checklist.md`), an ADR is required and is verified during Lead review.

## When NOT to write an ADR

Do **not** write an ADR for any of the following:

- Tooling version bumps within an existing pin range (e.g., a tilde-pinned patch update).
- Bug fixes that do not change observed behavior beyond the bug.
- Refactors that preserve external behavior.
- Cosmetic changes (formatting, comment edits, file renames that have no semantic effect).
- Decisions already locked in the four locked baseline documents — those are referenced, never re-decided.
- Speculative future decisions. ADRs document what *was* chosen, not what *might be* chosen.

If a change item does not warrant an ADR but introduces a non-obvious choice, document the rationale in the PR description instead. ADRs are reserved for decisions whose rationale needs to outlive any single PR.

## Numbering

ADRs are numbered sequentially starting at `0001`. Numbers are never reused, even after an ADR is deprecated or superseded. Filename format: `NNNN-short-kebab-case-subject.md` (zero-padded to four digits).

## Authorship

ADRs may be authored by Lead Engineers, the Architect, or Claude Code instances under Lead direction. The author records the decision; the Lead Engineer (or Architect, for refusal-layer or program-identity decisions) accepts it by setting `Status: Accepted`.
