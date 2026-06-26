# ADR-0020: Build For Tenant #50 (Astre Is The Test Harness) — Governing Principle

- **Status:** **Accepted — LOCKED governing principle** (PO-ratified, 2026-06-26)
- **Date:** 2026-06-26
- **Authority:** PO (Purush). Ratified this session.
- **Precedence:** This is a **governing principle**, not a single-PR convention. It sits **above** individual feature ADRs in precedence — where a feature ADR's scoping conflicts with this principle, this principle governs.
- **Canonical source:** `Aramo-Decision-Build-For-Tenant-50-v1_0-LOCKED.md` (OneDrive `Aramo/locked` canonical store; the LOCKED directive set — see `doc/01-locked-baselines.md`). This ADR is the in-repo, version-controlled rendering so the principle is discoverable alongside the ADR series.

---

## Context

Aramo is in a deliberate **pre-multi-tenant phase**. Astre — the first, dogfooding
tenant — is currently the only live tenant. The strategic question that recurs on
nearly every feature is: *do we scope this minimal for Astre, or general for the
platform?*

The recurring **failure mode** this decision guards against: scoping a feature to
the local optimum ("what makes the one live tenant work") when the program strategy
is the general optimum ("what makes the platform multi-tenant"). That scoping is
**invisibly wrong with one tenant** — everything works, Astre is happy — and becomes
a blocking, under-fire retrofit the moment a second tenant arrives. By then the
platform is live, onboarding is happening, and there is no controlled window left to
fix it. The cost of building the general capability is low and controlled *now*,
while Astre is the only live tenant; it is high and uncontrolled later.

A concrete instance that surfaced this principle: per-tenant IdP routing
(`astre.aramo.ai` → resolve tenant → inject the tenant's Cognito `identity_provider`).
The wrong scoping is "make Astre go to Microsoft"; the right scoping is "any tenant,
identified by their subdomain, routes to their configured IdP — Astre is just the
first row + the live test."

## Decision

**Aramo is built for tenant #50, not for Astre.** Astre is the **test harness** — the
live proving ground that forces every capability to exist *before* real multi-tenant
onboarding begins. Astre is the first row in every table and the first live test of
every flow — never the customer the platform is scoped to satisfy. The whole point of
dogfooding Astre first is to force every capability to exist before real multi-tenant
onboarding, so that when tenant #2 through #N arrive, the platform already does the
right thing with zero scramble.

### The rules (operational)

1. **Scope to the general capability, not the Astre-specific case.** Build the version
   that works for *any* tenant identified by their proper attributes — not the version
   that happens to make Astre work. Astre is then just the first row + the live test.

2. **A new tenant must be a DATA operation, not an INFRA/ENGINEERING operation.**
   Onboarding tenant #2 should be inserting a row (and the platform does the rest),
   never a human hand-touching DNS, Caddy, IAM, or code. If onboarding a tenant requires
   manual per-tenant infra or engineering, the capability is **not done** — it is
   single-tenant work re-run by hand.

3. **"It works for Astre today" is NOT a completion criterion.** A capability is complete
   when it works for an arbitrary future tenant with zero per-tenant scramble. "Astre
   works" is the *test passing*, not the *feature being done*.

4. **Solve for the future state during this phase — that is the phase's purpose.** Always
   ask: "what does this look like when multi-tenant onboarding is happening, and is the
   platform ready for that?" Building for that future state is the explicit job of this
   phase, not premature optimization.

5. **Reject minimal/defer-the-general-case scoping for core platform capabilities.**
   Deferring the general capability "until tenant #2 arrives" recreates the exact
   under-fire scramble this principle forbids. The general capability is built now, in
   the controlled single-tenant window, precisely because it is cheap now and expensive
   later.

### The boundary (what this does NOT mean)

This is **not** a license for speculative gold-plating or building for scale Aramo will
never hit. The distinction:

- **Build now:** capabilities that *every* multi-tenant onboarding will exercise — tenant
  identity/resolution, per-tenant auth routing, self-service provisioning paths, isolation
  primitives — the things that turn "a tenant" from a hand-built artifact into a platform
  row. These are *foundational*, not speculative.
- **Defer legitimately:** capabilities that solve a *scale* or *isolation tier* Aramo is
  genuinely not at and won't be for a long time — e.g. per-tenant Cognito user pools /
  cell-based architecture (Tier 3), which solve a contractual pool-isolation demand, not a
  present need. Deferring *these* is correct; the trigger is a real client requirement, not
  "tenant #2."

**The test:** is this something *every* tenant onboarding needs (build now), or something
only a *specific future client class* will demand (defer with a named trigger)? Foundational
multi-tenant capability → now. Specific-client-tier scale/isolation → deferred with a
documented trigger.

## Consequences

**Positive.**
- Scoping decisions across the program have a single, ratified tie-breaker: when in doubt,
  **build for tenant #50; Astre proves it works.**
- Core multi-tenant capability is built in the cheap, controlled single-tenant window rather
  than as an under-fire retrofit after go-live.
- "Done" acquires a sharper definition for platform capabilities: works for an arbitrary
  future tenant as a data operation, not "Astre works."

**Negative / cost.**
- Some features cost more up front than a strictly-Astre implementation would — accepted
  deliberately, because the general capability is cheap now and expensive later.
- Requires judgment at the boundary (foundational-now vs. specific-tier-deferred); the test
  above is the discriminator, and genuine Tier-3 scale work is explicitly *not* pulled forward.

**Neutral.**
- This principle governs *scope*, not *mechanism*. It does not prescribe how any specific
  capability is built — only that it be built for the general (multi-tenant) case.
- It supersedes minimal/single-tenant scoping in feature work but does not retroactively
  invalidate shipped work; it governs decisions from ratification forward.

## References

- **Canonical:** `Aramo-Decision-Build-For-Tenant-50-v1_0-LOCKED.md` (OneDrive `Aramo/locked`).
- `doc/01-locked-baselines.md` — the LOCKED baseline ledger this principle joins.
- `doc/adr/README.md` — ADR index; this principle is flagged there as a governing principle
  above the feature-ADR series.
- ADR-0001 (`doc/adr/0001-pr1-precedent-decisions.md`) — ADR format / Michael Nygard short-form template.
