<!--
Aramo PR template. Keep it light. The architecture-impact handover is the only
governance addition here — see doc/architecture/visual-architecture-synchronization-governance.md
-->

## Summary

<!-- what this PR does and why -->

## Architecture-impact handover (required for implementation PRs)

Per [Visual Architecture Synchronization Governance v1.0](../doc/architecture/visual-architecture-synchronization-governance.md),
every **implementation** PR merged on/after governance activation must include an
architecture-impact handover **before merge** — even when the impact is `NO_IMPACT`.

- [ ] Handover added at `doc/architecture/handovers/PR-<number>.md` (from [`TEMPLATE.md`](../doc/architecture/handovers/TEMPLATE.md)), **or**
- [ ] Not applicable — documentation-only / test-only / non-major-dependency PR (one-line `NO_IMPACT` handover), **or**
- [ ] Not applicable — this PR predates governance activation (covered by the transition reconciliation).

**Impact classification:** `NO_IMPACT` | `ADDITIVE` | `MODIFIED` | `RETIRED/SUPERSEDED` | `MATERIAL`

## Checklist

- [ ] Relevant [Lead-Review-Checklist](../doc/06-lead-review-checklist.md) items verified for this PR's tier
- [ ] `doc/recon/**` not modified (frozen evidence)
