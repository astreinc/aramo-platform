# Lane 7 — Commercial Lifecycle Extraction Register

**Status:** OPEN registry, produced during Lane 6 (Active Employment / Placement).
Lane 6 does **not** perform the extraction — it records the exact seams so a future
Lane 7 (Commercial Lifecycle) can extract `AssignmentRateVersion`,
`CommercialRevisionProposal`, rate-history ownership, and the bill/pay commercial
revision lifecycle out of `libs/placement` into their own boundary.

**Governing rulings (PO, 2026-09-01):** the commercial ledger MAY remain physically
co-located in `libs/placement` during Lane 6; physical co-location does **not** grant
Lane 6 ownership. Lane 6 treats commercial surfaces as neighboring/read-only deps
except where the assignment lifecycle must invoke an already-authoritative commercial
contract, and must **not** expand or redesign them. Extraction happens in Lane 7 (or
earlier only to eliminate a real authority violation — none found in Lane 6).

All line references are against `libs/placement/src/lib/placement.repository.ts` at the
Lane-6 baseline unless noted.

---

## A. Lifecycle → commercial MUTATION seams (the extraction-critical couplings)

These are the points where the **assignment lifecycle** directly mutates the
**commercial ledger** in the same transaction. A Lane-7 extraction must sever each of
these into a call across the lifecycle→commercial boundary (an authoritative commercial
contract the lifecycle invokes), rather than the lifecycle writing commercial tables.

1. **START / assignment mint → initial commercial terms.**
   `PlacementRepository.transition()` STARTED (CONTRACT branch) mints the initial
   `AssignmentRateVersion` from the caller-supplied `commercial_terms`
   (`tx.assignmentRateVersion.create`, ~L878), sharing the one transaction-level start
   instant (`effective_from` = assignment `started_at`, Amendment A1-8). Lifecycle
   *writes* commercial.

2. **END → commercial effective-window close/cancel.**
   `endAssignment()` cancels future/boundary rate-version windows
   (`tx.assignmentRateVersion.update`, ~L1001) and first-closes the containing window
   (`effective_to`, ~L1039/L1041). Lifecycle terminal event *mutates* commercial windows.

3. **CONVERT (contract→permanent) → commercial effective-window close/cancel.**
   `convertToPermanent()` cancels rate versions at/after `T_convert` (~L1319) and
   first-closes the containing window (~L1342/L1344). Lifecycle conversion *mutates*
   commercial windows.

**Authority-violation assessment (Lane 6):** at all three seams the lifecycle repository
mutates commercial tables directly. This is *hardenable in place* — no forced physical
split during Lane 6 — so these are registered as Lane-7 extraction debt, not Lane-6
redesign targets.

## B. Already-clean decouplings (no extraction debt)

- **Guarantee exposure** is a *governed input snapshot*, never derived from a rate
  version (`libs/placement/prisma/schema.prisma`, PermanentPlacement exposure columns).
- **Outbox** payloads carry identity/provenance only — never pay/bill/spread/margin/
  markup (repository outbox constants; PII/commercial-free by convention).

## C. Commercial surfaces to be OWNED by Lane 7 (finalized, L6-I)

These are the commercial ledger surfaces that live in `libs/placement` today and become
Lane 7's owned boundary. Lane 6 treats them as read-only neighbors and does not expand
or redesign them.

### C.1 Data models (`libs/placement/prisma/schema.prisma`)
- `AssignmentRateVersion` — append-only, effective-window (GiST overlap-exclusion +
  first-close), immutability trigger; pay/bill/currency/rate_period; derived
  spread/margin/markup computed on read, never stored.
- `CommercialRevisionProposal` — the Slice-#4 7-state SoD approval machine
  (APPROVED != APPLIED), one-live partial-unique.

### C.2 Commercial read projections (`placement.repository.ts`)
- `getAssignmentCommercialView` (~L1563) — AS-OF effective rate-version read; derives
  spread/margin/markup on read via `deriveCommercialMetrics`. Read model
  `AssignmentCommercialView` (`placement-process.types.ts`).

### C.3 Commercial revision commands (`placement.repository.ts`)
- `createCommercialRevision` (~L1651) — open-tail window close + successor append,
  FOR UPDATE lock, serialised against endAssignment.
- `createCommercialRevisionProposal` (~L1818) — capture intent (no apply).
- `decideCommercialRevisionProposal` (~L1950) — margin-approve / client-approve /
  apply (reuses createCommercialRevision under lock) / reject.
- `cancelCommercialRevision` (~L2222).
- Scopes: `assignment:commercials:read` / `:write` / `:approve`
  (`libs/identity/src/lib/dto/scope.dto.ts`); routes
  `apps/api/src/placement/placement.controller.ts` `:id/assignment/commercials/*`.

### C.4 Commercial reporting
- `libs/placement/src/lib/commercial-margin-read.repository.ts` — margin over ACTIVE
  CONTRACT `ContractAssignment` joined to its current `AssignmentRateVersion`
  (PermanentPlacement never participates). Route `GET /v1/reports/margin`
  (`libs/reporting/src/lib/reporting.controller.ts`), dual-scope `report:read` +
  `assignment:commercials:read`.

### C.5 Extraction ordering note
A Lane-7 extraction re-homes C.1–C.4 into a commercial boundary and rewrites the three
Section-A seams so the assignment lifecycle *invokes* an authoritative commercial contract
instead of writing the ledger tables directly. Guarantee-exposure (a governed input
snapshot on PermanentPlacement) is NOT commercial-ledger and stays with the guarantee
aggregate. No cross-schema FK exists to unwind — all cross-aggregate references are UUID
scalars.
