# ADR-0018 — Background Jobs Substrate

- **Status:** ACCEPTED
- **In-tree path:** `doc/adr/0018-background-jobs-substrate.md`
- **Original ratification:** M5 (PR-11; closes Plan v1.5 §M5 Track A item 6)
- **Anchor authored:** 2026-06-16 (consolidation of the decisions recorded in the M5 PR-11 directive §4 / Lead-Q dispositions and `aramo-handoff-m5-close.md` §0)

> **Anchor scope.** Consolidates the Aramo Core background-jobs substrate decisions ratified at M5 PR-11 — four BullMQ jobs implementing Architecture §9.2 / D-ENT-READY-1 G7. This anchor is the citable record; the per-decision audit mapping is in the PR-11 directive.

## Context

Architecture §9.2 and the D-ENT-READY-1 G7 binding call for four Aramo Core background jobs. M5 PR-11 ships them as BullMQ processors, establishing the workspace's background-jobs substrate by mirroring the existing `libs/matching` BullMQ pattern (processor + queue + module registration per job). Several jobs are scoped deliberately light at M5, with fuller behavior deferred to later milestones.

## Decisions

1. **Extension pattern.** Each job is a BullMQ processor in its owning lib, mirroring `libs/matching/src/lib/matching.processor.ts` (processor + `BullModule.registerQueue` + module wiring). Dedicated job-module per job; processors do not live in `CommonModule`.
2. **The four jobs.**
   - `libs/consent/.../stale-consent.processor.ts` — **implemented**.
   - `libs/consent/.../outbox-publisher.processor.ts` — **implemented** (consent-schema outbox only).
   - `libs/common/.../cross-schema-consistency.processor.ts` — **implemented** (critical-pairs only).
   - `libs/skills-taxonomy/.../skill-canonicalization.processor.ts` — **no-op framework** (deferred).
3. **Outbox scope (light).** The outbox publisher covers the **consent schema only** at M5 (consent outbox was already wired per PR-2). Engagement / submittal / examination outbox publishers are **deferred** (M6 expansion).
4. **Stale-consent trigger.** A BullMQ **repeating job** (`queue.add` with a repeat option) drives stale-consent detection.
5. **Stale-consent action.** On expiry, insert a `TalentConsentEvent` with `action = 'expired'` (append-only ledger discipline; consistent with the consent module's existing write conventions).
6. **Cross-schema consistency scope (critical-pairs only).** The consistency checker covers the **critical pairs** — consent/engagement/examination ↔ talent, and examination ↔ job_domain — not full cross-schema remediation. Full remediation is **deferred** (M6).
7. **Skill canonicalization (no-op framework).** The skill-canonicalization processor ships as a **no-op framework** with an explicit deferral note; meaningful canonicalization logic is deferred to the Skills Taxonomy workstream (M6). `libs/skills-taxonomy` ships structural binding only.
8. **Region discipline (PL-87).** Job-path write methods route to a dedicated repository (the R4 guardrail resolver-region discipline), not mixed into read repositories.
9. **Module-graph CI discipline (PL-89).** Gate 5 runs the full `pact:provider` suite when a change is module-graph-touching.

## Consequence / deferred work (M6 carry)

Three substantial expansions are explicitly deferred from this substrate and are M6/M7 charter candidates:
- **Multi-schema outbox** — engagement / submittal / examination publishers (M5 shipped consent-only).
- **Full cross-schema consistency remediation** — beyond the critical-pair check.
- **Skill canonicalization logic** — replacing the no-op framework (the Skills Taxonomy workstream).

## Relationship to other ADRs

- **ADR-0016 / ADR-0017** — the RDS substrate these jobs run against.
- **ADR-0008 Addendum** — the separated-gate structure under which PR-11 shipped.
