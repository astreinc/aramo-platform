# Talent workspace — design reference

`aramo-candidates-enterprise.html` is the **visual + interaction contract** for the
faceted Talent page (`src/talent/TalentListView.tsx`). It is a reference asset, not
a data source — its mock `C[]` array is illustrative only; the page wires to the real
`apps/api` contract.

Reconciliation rules applied when building from it (see the PR report):

- **Vocab:** the prototype is titled "Candidates"; the canonical entity is **Talent**
  (DDR §9 / CI Tier-2). All user-facing strings use Talent. This `design-reference/`
  dir is excluded from the vocab gate so the verbatim mockup may keep its original wording.
- **No scores/ratings (R10):** the prototype carries no rating column; the "Match
  insight" panel is a Core seam — "evidence and tier, never a score" — and stays unwired.
- **Export is a permanent moat (R7/DDR §8):** the bulk bar's "Export off — consent-
  protected" is a disabled affordance, never wired.
- **Honest stubs:** facets/columns whose fields don't exist on the talent record
  (status, availability, numeric rate range, engagement type, per-row consent,
  last-activity) render disabled with a one-line carry note rather than fabricated data.

> NOTE: the pristine UTF-8 `aramo-candidates-enterprise.html` should be dropped into
> this directory by the operator. The build received it as an inline attachment with
> transport encoding artifacts; committing that mojibake'd copy was declined in favor
> of this pointer. The canonical copy also lives in the locked design corpus.
