# ADR-0027: Client-Scoped Talent Restriction and the R10 Boundary

- **Status:** **Accepted — LOCKED** (PO-ratified, 2026-08-01)
- **Date:** 2026-08-01
- **Program:** Requisition Enterprise Program, amendment **A5**. Gates Track 3 (Placement + pre-start).
- **Numbering:** the ratified Planning Package reserves `0025` (lifecycle ADR) and `0026` (job-domain contract-only). This takes `0027`. Sequential, never reused; gaps are permitted, reuse is not.
- **Relates to:** ADR-0019 (**REJECTED**, 2026-06-16) · Charter §8 R10 · `doc/03-refusal-layer.md`

---

## Context

The Placement lifecycle must record why an engagement fell through. Some of those reasons originate **outside Aramo**: a client states that a person may not return to their site; a VMS marks a worker as restricted from resubmittal; an MSP declines a re-engagement.

The staffing-operational need is real. The question is whether recording it breaches the refusal layer.

### What ADR-0019 actually established

ADR-0019 proposed a manual 1–5 recruiter rating on Pipeline. It was **rejected**, and the rejection is broader than R10's literal text.

**R10 as written is a Portal boundary** — *"no portal-forbidden numeric/ordinal fields"*, *"tier or match output NEVER to a talent-facing view."* The rejected proposal was carefully built to satisfy that: not in any Portal DTO, excluded from the export allowlist, no Core semantics, recruiter-facing by construction.

**It was rejected anyway**, and the ruling extended the rule:

> *"Aramo deliberately does not let recruiters rate or ordinally sort talent. That refusal is a product moat, not an oversight."*
>
> *"Reframing it as 'recruiter-facing only' does not change that it introduces an ordinal judgment surface the product intends never to exist."*

**Therefore narrow scoping is not a defence.** That exact argument — *it is tightly scoped, it never reaches the forbidden surface* — has already been made and has already failed. Any proposal defended on scoping alone is a re-run of a rejected proposal with a different noun.

---

## Decision

**A client-scoped talent restriction may be recorded, on grounds that have nothing to do with scoping.**

### D1 — The distinction is AUTHORSHIP, not visibility

The rejected rating was *"the recruiter's own 1–5 mark"* — **Aramo generating an assessment of a person**.

A `ClientTalentRestriction` records **what an external party stated**. It is a fact about a third party's decision, attributable to that party, with a date. It is the same shape as *"the background check was not cleared on 14 July"* — an event that occurred, not a verdict Aramo formed.

**The test is: who is the author of the judgment?**
- Aramo or its recruiters authoring an assessment of a person → **prohibited**, without exception.
- Aramo recording a dated, attributed, externally-asserted constraint → **permitted**, under D2–D6.

### D2 — Recruiter opinion alone may NEVER create one

This is the load-bearing constraint, not a safeguard around one.

If a recruiter can create a restriction from their own judgment, it is **a rating with one value**, and D1's distinction collapses entirely. Every restriction requires an **identified external asserter** — client, MSP, VMS, or a legal/compliance determination — recorded in `source_system` with a `source_reference` and the `raw_source_value` as received.

**A restriction with no external asserter is invalid and must be rejected at write time.** Not warned. Rejected.

### D3 — It is NOT ordinal, and may never become ordinal

No scale. No score. No count. No rank.

**Explicitly prohibited:**
- Sorting or ranking talent by restrictions, anywhere
- **Aggregating across clients** — *"this person has 4 restrictions"* is an ordinal judgment on a person assembled from non-ordinal parts, and is the most likely route back into ADR-0019's territory
- Any derived "risk", "quality", "reliability" or similar signal
- Any count exposed in a list, facet, badge or report

### D4 — Client-scoped means client-scoped

A restriction applies **only** to the named client/account. It is:
- **Never** visible outside that client's context
- **Never** a property of the talent — no `Talent.rehire_eligible`, no `do_not_rehire`, no equivalent under any name
- **Never** cross-tenant, and never an input to any cross-tenant attestation
- **Never** a filter over the talent population (*"show me all restricted talent"* is prohibited; *"is this person restricted at this client"* in a submittal context is the permitted read)

### D5 — Never an input to matching or automated judgment

No Aramo Core path may read a restriction as a signal. Not for matching, ranking, scoring, surfacing or suppression. **A restriction is displayed to a human deciding about one client engagement; it never participates in a computation about a person.**

Aramo Core writing a restriction is likewise prohibited — that would make Aramo the author, breaching D1.

### D6 — Effective-dated and reversible

Restrictions expire, are lifted, and are asserted in error. `effective_from` / `effective_to`, and reversal by setting an end date — **never by deletion**, which would erase the fact that it was asserted.

---

## Shape

```
ClientTalentRestriction
  tenant_id            scoping
  client_company_id    the ONLY account this applies to (D4)
  talent_record_id     subject
  restriction_type     closed registry (below)
  source_system        WHO asserted it — REQUIRED, no default (D2)
  source_reference     their identifier for it
  raw_source_value     verbatim as received — never normalised away
  reason_code          canonical mapping of raw_source_value
  effective_from       required
  effective_to         nullable — null = currently in effect (D6)
  recorded_at
  recorded_by          who entered it into Aramo (NOT who asserted it)
```

**`source_system` and `recorded_by` are different fields and must not be conflated.** One is the external author of the judgment; the other is the Aramo user who transcribed it. Collapsing them makes a recruiter the author and breaches D1/D2.

**Restriction types (closed registry, extensible only by amendment):**
`CLIENT_DO_NOT_RESUBMIT` · `CLIENT_NOT_ELIGIBLE_FOR_REENGAGEMENT` · `CLIENT_SITE_ACCESS_RESTRICTED` · `VMS_SUBMITTAL_RESTRICTED`

Vocabulary: **`SUBMITTAL`, never `SUBMISSION`** — Tier-2 banned, CI-enforced.

---

## Boundary tripwires

A reviewer confirms the boundary holds by checking:

1. No write path creates a restriction without a populated `source_system` **and** `source_reference`.
2. No query aggregates or counts restrictions across clients.
3. No sort, rank or ordering uses restrictions.
4. No Portal DTO contains a restriction, in any form.
5. No matching, scoring or Core path reads them.
6. No field named `rehire_eligible`, `do_not_rehire`, or equivalent exists on any talent entity.
7. No talent-population filter keyed on restrictions exists.
8. Reversal is by `effective_to`, never `DELETE`.

**If any tripwire fires, the implementation has crossed into ADR-0019 territory and must stop.**

---

## Consequences

**Positive.** A genuine staffing-operational fact becomes recordable with full provenance. Fallthrough reasons originating with a client or VMS stop living in free-text notes. The distinction between *recording an external decision* and *forming a judgment* is now written down and testable.

**Negative.** The external-asserter requirement is friction: a recruiter who knows a client will not take someone back cannot record it until the client says so through an identifiable channel. **That friction is the boundary, not a defect in it.** Removing it converts this into ADR-0019.

**Neutral.** Does not change R10's Portal boundary. Does not authorise any talent-facing surface — that would be a new decision requiring its own ratification.

## Register

1. **The operative rule is broader than R10's written text.** R10 as written is a Portal boundary; the 2026-06-14 ADR-0019 rejection extended it to *"Aramo does not let recruiters rate or ordinally sort talent"* regardless of surface. `doc/03-refusal-layer.md` should be amended to state the broader rule, so the next reader does not repeat the rejected proposal's mistake of satisfying the literal text.
2. **Fallthrough reason codes (Track 3) are adjacent but distinct.** A fallthrough reason records what happened in one episode. A restriction is a standing constraint. A fallthrough must not silently create a restriction.
