# ADR-0029 — Candidate Intelligence Pipeline Boundary: Modular Monolith, Extract When Forced

- **Status:** ACCEPTED · LOCKED
- **In-tree path:** `doc/adr/0029-pipeline-boundary-modular-monolith.md`
- **Original ratification:** 2026-06-30 (PO-ratified; filed with a provisional ADR-0017 identifier)
- **Identifier corrected:** 2026-08-09 under G-REC-1 — provisional ADR-0017 → **ADR-0029**. Decision unchanged. Supersedes only the provisional ADR-0017 *identifier* for this decision. **ADR-0017 remains RDS Disaster Recovery Strategy.**
- **Enforces:** invariant **I15** (Pipeline⊥ATS import wall), CI-enforced via nx boundary tags + negative-control specs.

> **Anchor scope.** Citable record of the Pipeline-Boundary "modular monolith, extract when forced" decision (D1–D5, the forcing function, I15). The full decision text is the in-tree ADR above; the canonical LOCKED source is filed at OneDrive `Aramo/locked/`. The provisional ADR-0017 Pipeline artifact is retained there as historical evidence with an identifier-supersession stamp.

## Relationship to other ADRs
- **ADR-0017** — RDS Disaster Recovery Strategy (distinct subject; retains number 0017).
- **ADR-0016** — RDS Substrate Conventions / Identity model (see also the open ADR-0016 parallel-collision governance-hygiene item: LOCKED RDS-Substrate-Conventions vs non-LOCKED Identity-Model-Realignment).
- **I1 / I14** — consistent (UUID-only cross-schema; `identity_index` PII/tenant boundary). No invariant relaxed.
