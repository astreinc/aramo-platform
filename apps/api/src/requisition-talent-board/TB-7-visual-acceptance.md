# Requisition Talent Board — TB-7 visual acceptance record (Gate-5 FIX_NOW 3)

Visual acceptance was **performed** (not waived): the Board surface was rendered
with representative data using the production `rc-tboard*` stylesheet (extracted
verbatim from `apps/ats-web/src/ui/ui.css`) and captured headless via Playwright
+ Chromium at both required viewports, then inspected and compared against the
canonical prototype (`TalentBoard.dc.html`).

## Method
- Harness: the real `rc-tboard*` CSS + Confident-Blue design tokens, populated
  with a representative board (11 canonical columns; Qualified two-band split;
  governed action buttons; a drop-target column; tracked/handoff cards; an
  expanded Closed panel).
- Renderer: Playwright (chromium-1223) at **1440×900** and **1024×768**.
- Screenshots captured in the session scratchpad: `board-1440.png`,
  `board-1024.png` (full-page). Inspected directly.

## Verified surfaces (both 1440px and 1024px)
| Surface | Result |
|---|---|
| List \| Board toggle | Board pill active (brand), List inactive — correct |
| Populated actionable lanes | Pipeline / Contacted / Qualified / Submitted / Interviewing / Client Selected with counts + cards |
| Qualified Ready-to-submit band | green "Ready to submit" pill + "Résumé locked" + "Submit to client" action |
| Qualified Needs-action band | amber "Needs action" + "RTR needed" + blockers ("Right to represent not executed · Restricted at client"; "Résumé not selected") |
| Governed action buttons | Mark contacted / Start qualification / Submit to client / Mark client selected / Create offer — rendered per card state |
| Drag drop-target | Interviewing column shows the dashed brand outline (`rc-tboard__col--drop`) |
| Downstream tracking / handoff | Offer + Started cards render dashed with a "Tracked · Offer" / "Tracked · Placement" chip |
| Closed summary + expansion | `<details>` open: Not in consideration (2) · Client declined (1) · Offer declined (1); total 4 |
| Talent-on-Requisition drawer | the EXISTING `TalentDetailPanel` (unchanged by this work; opened via `onSelectCard`); covered by `TalentDetailPanel.spec.tsx` — reused as-is, not re-styled |

## Horizontal-scroll invariant (measured programmatically, both viewports)
The page **body never scrolls horizontally**; the columns scroll inside their own
container (`.rc-tboard__cols` `overflow-x:auto`):

- 1440: `bodyOverflowsX=false`, `colsScrollsX=true` (cols 2442px inside a 1392px body)
- 1024: `bodyOverflowsX=false`, `colsScrollsX=true` (cols 2442px inside a 976px body)

## Class-collision fix (found during this step)
The Board root class `rc-board` collided with the Tasks feature's existing
`.rc-board` grid (`TaskBoard.tsx`). The entire Board family was renamed to
`rc-tboard*` (Tasks `.rc-board` left untouched); FE specs + funnel-css-drift
guard re-verified green.

Result: **1440px and 1024px visual acceptance complete**, consistent with the
prototype; the body-no-horizontal-scroll requirement is proven at both widths.
