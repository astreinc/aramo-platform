# ADR-0007 — Talent Right-to-be-Forgotten / Anonymization (Decision F)

- **Status:** ACCEPTED (deferred implementation)
- **In-tree path:** `doc/adr/0007-talent-rtbf-anonymization.md`
- **Original ratification:** early program (pre-M5)
- **Anchor authored:** 2026-06-16 (consolidation of the decision recorded across the M5-close handoff, Session-Handoff v1.0, Backlog v1.0, and the consent-repository DTO docstrings that cite "ADR-0007 Decision F")

> **Anchor scope.** This file anchors **Decision F** of ADR-0007 — the right-to-be-forgotten / anonymization decision — because it is the cited, load-bearing carry the M6/M7 charter must reference. ADR-0007's other lettered decisions predate the current corpus and are not reproduced here; if they require anchoring, their text must come from the original ADR-0007 source.

## Context

Aramo stores candidate PII across a multi-tenant data model (declared profile, contact methods, work authorization, ingested sources, and — since the ADR-0015 résumé-text addendum — full résumé body text). Data-protection regimes require that a verified erasure request be honored. A naive hard-delete is inadequate: it would break referential integrity with the append-only event/consent ledgers and audit records that the platform's compliance posture depends on.

## Decision F

Right-to-be-forgotten is realized as a **talent-module anonymization state machine**, not a hard delete. On a verified erasure request, the talent's PII-bearing fields are anonymized/tombstoned while referential anchors and append-only audit/consent history are preserved in a non-identifying form. An `is_anonymized` state flag on the talent record is the externally-observable marker of this state.

The **build of this state machine is deferred** to a future milestone. At ratification time only the design intent and the `is_anonymized` placeholder were established.

## Current state (as of this anchor)

- `is_anonymized` is a **hardcoded `false` placeholder** in the consent repository — the flag exists; the machine that would set it does not.
  - **Amendment (TR-15 B2, 2026-07-11):** `is_anonymized` is no longer hardcoded — the consent reads now derive it from a retained `audit."ConsentAuditEvent"` marker (`event_type='consent.erased'`) written **only** by the `erase-talent` CLI (a real chain-erase over the full holder inventory, not the deferred anonymization state machine). The Decision-F *anonymization* state machine remains deferred; the flag now flips true on this erasure path. See [doc/runbooks/talent-rtbf-erasure.md](../runbooks/talent-rtbf-erasure.md).
- The only erasure actually implemented is a **narrow purge-on-delete cascade for the résumé-text blob** (`ON DELETE CASCADE` on the résumé-text table, ADR-0015 résumé-text decision). This covers one PII blob, not the talent.
- There is **no talent-delete cascade and no general anonymization hook**; the résumé *file* (Attachment, cross-schema UUID-only/no-FK) still orphans on talent-delete.
- **A verified deletion request cannot be fully honored today.**

## Consequence / priority

Persisting full résumé body text (ADR-0015) **raised the priority** of this carry — there is now substantially more candidate PII at rest than the placeholder erasure path can clear. This is recorded in Backlog v1.0 Phase 3 as the single most load-bearing compliance carry, and is a primary load-bearing candidate for the M6/M7 charter.
