<!--
Architecture-Impact Handover TEMPLATE — Aramo Visual Architecture Synchronization
Governance v1.0. Instantiate as doc/architecture/handovers/PR-<number>.md (see
README.md in this directory). Required for every prospective implementation PR
merged on/after governance activation, even when impact is NO_IMPACT.
A handover is INPUT TO SYNCHRONIZATION — it is NOT architecture approval and does
NOT change any artifact's lifecycle state. Describe the implementation accurately;
do not soften wording to evade the vocabulary guard — report blockers instead.
-->

# Architecture-Impact Handover — PR #<number>

- **PR number & title:** #<number> — <title>
- **Implementation head SHA:** `<40-hex head commit SHA at time of writing>`
  <!-- the pre-merge head SHA; do NOT invent a merge SHA — the merge SHA is
       recorded post-merge by the synchronization engineer in SYNC-REGISTER -->
- **Author:** <Claude Code session / engineer>
- **Date (UTC):** <YYYY-MM-DD>

## Architecture impact classification

`NO_IMPACT` | `ADDITIVE` | `MODIFIED` | `RETIRED/SUPERSEDED` | `MATERIAL`

> One value. `MATERIAL` or `RETIRED/SUPERSEDED` → flag for Architect review and, if
> a retirement/supersession, note it for `Aramo-Architecture-Change-History.md`.

## Summary of actual implemented changes

<2–5 sentences describing what the code actually does now. Facts only.>

## Affected surfaces

State `none` explicitly where there is no impact.

| Surface | Affected? | Detail + evidence (`path:line`, OpenAPI/pact) |
|---|---|---|
| Modules | none / … | |
| APIs (routes/contracts) | none / … | |
| Database entities / migrations | none / … | |
| Events | none / … | |
| Integrations (external) | none / … | |
| Security boundaries (authn/authz/tenant) | none / … | |
| User journeys | none / … | |

## Source-code & contract evidence

- `<path:line>` — <symbol / what it shows>
- `<openapi/*.yaml / pact/...>` — <contract reference>

## Existing architecture artifacts potentially affected

- Visual-Index artifact ID(s): `<ID>` — or, if unavailable, `doc/recon/` domain(s):
  `D01`…`D15` (name the domain docs this change touches).

## Recommended new architecture artifacts (if any)

- <diagram/view suggestion + why> — or `none`.

## Known limitations & unresolved questions

- <open items, assumptions, `NOT VERIFIED` areas> — or `none`.

---
*This handover records implementation impact only. It confers no lifecycle
authority and does not modify `doc/recon/` evidence.*
