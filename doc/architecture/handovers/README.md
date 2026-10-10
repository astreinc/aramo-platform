# Architecture-Impact Handovers

Per-PR, pre-merge records of the **actual** architecture impact of a prospective
implementation PR, under
[Visual Architecture Synchronization Governance v1.0](../visual-architecture-synchronization-governance.md).

## Rules

- **One handover per prospective implementation PR**, required **before merge**,
  even when impact is `NO_IMPACT`. (PRs merged on/after the governance activation
  SHA — see the governance doc's activation rule.)
- Instantiate from [`TEMPLATE.md`](TEMPLATE.md).
- **Canonical filename:** `PR-<number>.md`, using the PR number as the stable
  identifier. Before a number is assigned you may start with a temporary draft
  name (e.g. `PR-DRAFT-<branch>.md`); **rename to `PR-<number>.md` before merge** —
  the canonical numbered file must exist at merge time.
- Record the **pre-merge implementation head SHA** in the handover. **Do not
  invent a merge SHA** — the merge commit SHA is recorded post-merge by the
  synchronization engineer in
  [`../visual-index/SYNC-REGISTER.md`](../visual-index/SYNC-REGISTER.md).
- Update the handover if the implementation **materially changes** before merge.
- Use **Visual-Index artifact IDs** when available; otherwise reference
  `doc/recon/` domains **D01–D15**.

## What a handover is not

- Not architecture approval; it does not advance any artifact's lifecycle/review
  state.
- Not a place for semantic retirement/supersession decisions — those follow
  [`doc/governance/history/Aramo-Architecture-Change-History.md`](../../governance/history/Aramo-Architecture-Change-History.md).

## Scope exceptions

Documentation-only / test-only / non-major-dependency PRs use the one-line
`NO_IMPACT` path. Emergency/hotfix PRs may file retroactively within 24h
(recorded `deferred→filed` in the SYNC-REGISTER). See the governance doc for the
full exception policy.

## Historical & transition periods

- Historical PRs represented by `doc/recon/` @ `12330b0f` require **no** handover.
- PRs merged in `(12330b0f .. ACTIVATION]` are covered by the single
  [`../visual-index/TRANSITION-RECONCILIATION.md`](../visual-index/TRANSITION-RECONCILIATION.md),
  not by individual handovers.
