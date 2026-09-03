# Requisition UI — DESIGN GAP register

Bounded backend-capability gaps discovered while converging the Requisition UI
onto the approved `.dc.html` prototype. Per the build authorization these are
**recorded, not built** — no new backend surface is created during this FE build.

## GAP-1 — Requisition-grain downstream funnel rollup (Submitted / Interview)
- **Prototype element:** List TALENT column, 3-cell block `In pipeline · Submitted · Interview` (`Requisitions.dc.html`).
- **Expected:** truthful per-requisition counts for Submitted and Interview.
- **Current repo capability:** `In pipeline` is a real Pipeline-backed requisition-grain count (one unfiltered `GET /v1/pipelines` → `funnelByRequisition`, no fan-out). Submitted is owned by Submittal; Interview by ClientSelection. There is **no** requisition-grain rollup endpoint for those owners; the only truthful source is per-episode `GET /v1/pipelines/:id/journey`, which at list scale is per-talent fan-out (forbidden by the loading contract).
- **Missing capability:** a bounded `GET /v1/requisitions/:id/funnel` (or list-embedded) rollup returning owner-sourced Submitted/Interview totals.
- **FE handling now:** render the cells with a muted `—` (never a fabricated count, never a false `0`), per Ruling 3.
- **Recommended bounded follow-up:** add a requisition-grain funnel-rollup read composed server-side from the owning aggregates (Submittal/ClientSelection), then swap the muted `—` for the real value.

## GAP-2 — ATTENTION column aggregate conditions
- **Prototype element:** List ATTENTION column (`Requisitions.dc.html`).
- **Current repo capability:** attention is grounded from already-loaded requisition-grain data (req fields + the single pipeline funnel): client-submittals-closed, qualified-talent-present-and-open (prepare submittal), no-activity-while-aging, priority, aging. Conditions that need downstream rollups (e.g. "client waiting N days", "interview today") are **not** grounded and are not shown.
- **FE handling now:** only grounded conditions render; otherwise a muted `—`. The list's global attention banner keeps its existing grounded behavior.
- **Recommended bounded follow-up:** same rollup as GAP-1 would enable additional grounded attention items.

## GAP-3 — No capability/scope self-read endpoint
- **Prototype element:** role/scope-sensitive affordances (cards, tabs, actions).
- **Current repo capability:** `GET /v1/me` returns roles + display only, not scopes/capabilities; the FE reads scopes from the session (JWT) and journey `actions[]`.
- **FE handling now:** capability/scope-driven from the session + journey actions (never a role-name switch). No production role/persona simulator is shipped.
- **Recommended bounded follow-up:** optional server-provided capability manifest.

## GAP-4 — Journey action with no delivered drawer FE path
- **Prototype element:** drawer next-step CTA.
- **Current repo capability:** journey `actions[]` may name an owner command (e.g. pipeline advance) with no dedicated in-drawer FE surface.
- **FE handling now:** wired actions — submittal (`/talent/:id/submittal/:reqId`), client-selection/interview (`/selections/:id`), offer (in-drawer `OfferPanelContainer`, SELECTED-gated). Any returned action lacking a delivered path renders **no CTA** and is registered via `onActionGap` (never fabricated).
- **Recommended bounded follow-up:** add the missing owner surfaces (e.g. an in-context pipeline-advance affordance) as separately-authorized work.
