# T2-P3B — Selection-native migration rebaseline: production reconciliation plan

> **NOT EXECUTABLE AUTHORITY. NO PRODUCTION ACTION IS AUTHORIZED BY THIS
> DOCUMENT.** This artifact describes the eventual, separately-governed
> production reconciliation required after the pre-GA Selection migration
> rebaseline. It is illustrative and planning-only. Every command shown is
> non-executable reference material; production execution requires an explicit,
> separate Architect + PO authorization and a change window. T2-P3B performed
> **no** production mutation, no ledger change, no migration run, no reset.

## 1. Why this exists

T2-P3B replaced the six engagement-first Selection migrations with a single
Selection-native migration `20260525120000_init_selection_model`:

| Superseded (removed from repo) | Folded into |
|---|---|
| `20260525120000_init_engagement_model` | `20260525120000_init_selection_model` |
| `20260525150000_add_engagement_event_log` | ″ |
| `20260531000000_add_outbox_event` (selection) | ″ |
| `20260609000000` (drafted-event-type enum value) | ″ (enum value in workflow order) |
| `20260706240000_tr2a_b3b_reconcile_rekey_exemption` (selection) | ″ (state fn GUC exemption) |
| `20260813120000_t2p2_relocate_engagement_to_selection` | ″ (native `selection` schema) |

Because the production migration ledger `public._local_migrations` is
**path-keyed** (`deploy/migrate-prod.sh` → `tools/db-sync-local.sh`), the
repository baseline now diverges from what production recorded. This divergence
is intentional and is held safe by the fail-closed guard in
`tools/db-sync-local.sh` (§4 below).

## 2. Observed production state (from recon 2026-08-12; READ-ONLY, not re-verified here)

- Five engagement-era migrations recorded as applied (init_engagement_model,
  add_engagement_event_log, add_outbox_event, the drafted-event-type enum-value
  migration, tr2a_b3b_reconcile_rekey_exemption).
- **T2-P2 relocation NOT applied**; the `selection` schema is **absent** in
  production. The live workflow schema is `engagement`.
- Relevant workflow / event / evidence / metering / submittal rows = **ZERO**
  (P1 classification). Evidence `TalentJobEvidencePackage` rows = 0.
- Unrelated business data exists and is OUT of this blast radius: ~2 tenant
  rows, ~7 talent records.
- Running-image release revision: **not determinable** from recon (predates the
  GLH-2-A /version provenance surface).

> The reconciliation MUST re-verify all of the above live, immediately before
> execution. If any relevant workflow/evidence row count is non-zero, STOP —
> this plan (which assumes an empty Selection blast radius) does not apply.

## 3. Required future governed operation (illustrative; do NOT run here)

Preconditions (all mandatory, verified live at execution time):
1. Explicit Architect + PO authorization for the production action.
2. Full database backup / snapshot taken and verified restorable.
3. Release hold: no app deploy of the Selection-native code until this
   reconciliation completes (the app expects the `selection` schema).
4. Live re-verification of §2 (zero relevant rows; `engagement` schema present;
   `selection` schema absent).

Reconciliation steps (illustrative, non-executable):
1. Confirm the `engagement` schema holds zero workflow/event/outbox rows.
2. Drop the empty engagement-era Selection objects (schema `engagement` and its
   `TalentJobEngagement` / `TalentEngagementEvent` / `OutboxEvent` tables,
   enums, trigger functions) — only after the zero-row re-verification.
3. Apply the Selection-native baseline (`init_selection_model`) to create the
   canonical `selection` schema directly.
4. Reconcile the ledger `public._local_migrations`: remove the five superseded
   engagement-era path rows and record the single Selection-native path
   `libs/selection/prisma/migrations/20260525120000_init_selection_model/`.
5. Rebaseline the Evidence field: production `TalentJobEvidencePackage` rows = 0,
   so the `engagement_event_refs` column is renamed / recreated as
   `selection_event_refs` (per the rebaselined evidence init migration).
6. Post-operation verification: `selection` schema + `TalentSelection` /
   `TalentSelectionEvent` / `OutboxEvent` present; enums / trigger functions /
   FK / indexes present; the fail-closed guard passes (no superseded ledger
   rows remain); a `db:sync:local --status` shows N/N.

Rollback / abort points:
- Before step 2: abort freely (no mutation yet).
- After backup, before app deploy: restore from the verified snapshot.
- The app deploy remains gated on this reconciliation succeeding.

## 4. Interim safety — fail-closed guard (already implemented in T2-P3B)

`tools/db-sync-local.sh` refuses to migrate any environment whose ledger still
records the superseded engagement-era Selection paths while the repository ships
`init_selection_model`. It exits non-zero (code 3) with an actionable message
and **never** auto-repairs. This prevents the dangerous outcome of new-repo +
old-ledger silently reapplying DDL and creating a divergent second schema.
`deploy/migrate-prod.sh` invokes `tools/db-sync-local.sh`, so production inherits
the guard.
