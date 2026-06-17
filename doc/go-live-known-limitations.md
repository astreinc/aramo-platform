# Go-Live Known-Limitations Register

Deliberate gaps shipped to production with enforcement/behavior intentionally
deferred. Each entry states what is present, what is NOT yet enforced, and the
trust implication. Reviewed at each go-live gate.

> New entries: append under the relevant area with the date, the PR/branch, and
> an explicit "Risk" line. Do not remove an entry until the deferral is closed
> (link the closing PR).

---

## Companies

### off_limits: display-only, enforcement deferred
- **Date:** 2026-06-16 · **Branch:** `feat/companies-mockup-parity`
- **Present:** `company.off_limits` boolean field; account-hub off-limits banner;
  list facet + form toggle; included in company create/update + search facets.
- **NOT enforced:** the do-not-source flag is **display-only**. Nothing in
  sourcing / talent search / engagement reads `off_limits` to exclude an
  off-limits client's own people from a working set. Setting the flag changes
  what a recruiter *sees*, not what the system *permits*.
- **Risk:** a "do-not-source" banner the system does not enforce is a **trust
  gap** — an operator may rely on it as a guardrail it is not. Treat as
  informational only until enforcement lands.
- **Close criteria:** wire `off_limits` into the sourcing/search predicate so an
  off-limits company's employees are excluded from talent working sets (requires
  the talent→employer→company linkage), with a test proving exclusion.
