# Aramo — ATS Go-Live Hardening Charter v1.5 (Continuation) — In-Repo Materialization Record

> **Type:** In-repo governance materialization of a PO/Architect disposition. This
> record makes the v1.5 continuation authority visible at the repository SHA under
> which the GLH work is executed. It is a *reflection* of the ruling, not a
> substitute for the canonical LOCKED artifact: the canonical
> `Aramo-ATS-Go-Live-Hardening-Charter-v1_5-LOCKED` filing to the OneDrive `Aramo/locked`
> root remains the Architect's ratification act. Where this record and the canonical
> LOCKED charter differ, the LOCKED charter wins.

## Anchor

- **Authority SHA:** `origin/main = e9150341c6ffdc1167a7b804498aebcca350c661` (Merge #601 — T2-ARCH selection/submittal topology ratification).
- **Disposition date:** 2026-08-10 (PO/Architect: "Go-Live Hardening Continuation — Anchor Ratification + GLH-1 Activation").
- **Supersedes-in-continuation:** `Aramo-ATS-Go-Live-Hardening-Charter-v1_4-LOCKED` (continuation/amendment; v1.4 is **not** altered in place).

## Rulings materialized

1. **Program Track 10 is UNCHANGED.** In the Requisition Enterprise Program,
   **T10 = CROSS-MODULE UX CONSISTENCY / FINAL COHERENCE** (Planning Package v1.0 §7;
   Master Execution Ledger v1.7 §5/§7, v1.8). T10 authority is **not** re-scoped to
   accommodate infrastructure / operations / release work. This numbering conflict was
   raised in recon and resolved by ratifying the anchor below.

2. **Infrastructure / operations / release hardening is NOT Program T10.** It is
   re-anchored under this **ATS Go-Live Hardening Charter v1.5**, a continuation of the
   existing Go-Live Hardening authority (v1.0–v1.4), sitting alongside the Single-Box Ops
   and Release-Runbook directives.

3. **DR target preserved.** `ADR-0017 — RDS Disaster Recovery Strategy` remains the
   **TARGET** architecture (RDS / PITR, RPO 15m, RTO 1h, 35-day retention). It is **not**
   weakened to match the current Lightsail single-box. The live single-box backup posture
   (daily `pg_dump` → S3; effective RPO up to ~24h; no PITR) is recorded as a
   **TRANSITIONAL DEVIATION** whose recovery characteristics do not yet satisfy the target
   ADR. RDS migration is a separate, later, separately-authorized activity.

4. **GLH increment sequence (each separately authorized, each its own Gate-6):**
   - **GLH-1 — CI Integrity** *(authorized by the 2026-08-10 disposition; this branch)*
   - **GLH-2 — Release Integrity** *(not authorized)*
   - **GLH-3 — Observability Floor** *(not authorized)*
   - **GLH-4 — Additive Production Smoke** *(not authorized)*
   - **GLH-5 — IaC Hygiene** *(not authorized)*

5. **Deployment remains separately authorized.** No GLH increment authorizes a
   deployment, production migration, Terraform apply, production reset, or secret rotation.
   *Implementation complete ≠ deployment authorized ≠ production validated.*

## GLH-1 scope (this branch)

CI INTEGRITY ONLY — four generic, convention-driven gates:

- **A.** `build` becomes a required member of the aggregate `deployment-gate`.
- **B.** `verify-vocabulary` becomes a required member of the aggregate `deployment-gate`.
- **C.** A non-vacuous **bidirectional API-contract parity** gate over the *authority-defined
  governed public API surface* (undocumented governed route ∥ orphan OpenAPI operation).
  Subject to `ARCHITECTURE_HALT` if the governed surface cannot be determined without
  silently redefining contract policy.
- **D.** **Env-passthrough parity** — a production code-read / declared runtime variable
  omitted from the production compose pass-through or the declared env contract is caught.

GLH-1 changes **only** CI workflow + CI scripts (+ the minimal FIX_NOW required to ship a
GREEN gate, classified explicitly). It does not repair product tracks, and does not touch
`ci/integration-roots.json`, OpenAPI documents, or repo-map artifacts except where a gate
requires it.
