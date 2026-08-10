# ADR-0029 — Candidate Intelligence Pipeline Boundary: Modular Monolith, Extract When Forced

**Status:** ACCEPTED · LOCKED · **Date:** 2026-06-30 · **Author:** Lead/Architect (PO-ratified)
**Identifier lineage:** This decision was originally filed with a **provisional ADR-0017**
identifier (self-flagged "confirm against the register"). ADR-0017 was already the RDS Disaster
Recovery Strategy. Under G-REC-1 (2026-08-09) the identifier is corrected to **ADR-0029**.
**The architectural decision is unchanged.** ADR-0029 supersedes only the provisional ADR-0017
*identifier* for this decision; **ADR-0017 remains RDS Disaster Recovery Strategy.**
**Spec:** Talent Lifecycle & Trust Architecture v1.1 — this ADR adds invariant **I15** and is cross-referenced from §1 (productization) and §8 (invariants).
**Binding:** This is a **build-time ruling.** Claude Code and all directives are bound by it. It must not be drifted from, relaxed, or "optimized around" in any increment without a superseding ADR. CI enforces the load-bearing part (I15).

---

## 1. Context

The Candidate Intelligence Pipeline (L1 `sourced_candidate` + L2 `talent_trust`/`identity_index` + the TR-2…TR-15 intelligence) must be **decoupled and portable** — it is the basis of the tier-3 product (Pipeline-only, connected into a customer's existing ATS such as Bullhorn/Workday) and the strategic claim of "trust infrastructure for the staffing industry."

A natural impulse is to enforce this portability by **physically separating** the Pipeline into its own repository and database now. This ADR rules against doing that now, and rules *for* a discipline that delivers the same portability without the cost — and names the exact condition under which physical extraction *does* happen.

**The distinction this ADR rests on:** *logical* decoupling (boundary discipline) is what makes the Pipeline portable; *physical* separation (own repo/DB/service) merely **cashes in** that portability. Physical separation does not create decoupling — and applied to a still-coupled boundary it makes things strictly worse (an in-process tangle becomes a distributed-systems tangle, now with a network in the middle).

**The strategic trap avoided:** Aramo's moat is the **full native stack** (ATS + Pipeline, in-process, fast — the center of gravity). Pipeline-only-into-an-external-ATS is the **wedge** (land-and-expand on-ramp), explicitly *not* the center of gravity. Splitting the Pipeline into its own service *now* would put a network boundary *inside the moat product* — every full-stack customer pays cross-service latency, distributed failure modes, and operational overhead **to serve a tier-3 product that has no customer yet.** That optimizes the wedge at the expense of the moat. Rejected.

## 2. Decision — modular monolith, extract when forced

**D1 — The Pipeline stays in the monorepo, with the boundary made HARD.** Logical decoupling, zero distributed-systems tax; the moat product stays fast and simple. Portability is guaranteed not by physical separation but by **continuously-verified extractability** — three mechanisms (D2–D4) that make "we can extract the Pipeline" a fact the build proves every day, not an aspiration that quietly rots.

**D2 — I15: the Pipeline⊥ATS import wall (CI-enforced — the load-bearing invariant).** The Pipeline intelligence libs MUST NOT directly import the ATS libs. The Pipeline crosses the L3 boundary **only by UUID reference and through the connector contract (D3)** — never a hard import, never a cross-schema FK (consistent with I1). Enforced via **nx boundary tags**; the build FAILS on a violating import. This is the wall that I14 is for the PII boundary — compiler-checked, not convention. (Exact lib partition — D5.)

**D3 — Contract-first L3 seam.** The Pipeline talks to the ATS (and the ATS to the Pipeline) only through a **first-class, versioned, Pact-tested connector contract**, *even in-process.* The Pipeline is therefore — logically — already "a service behind a contract," and that contract is tested on every PR. The connector contract + the Trust Assessment format are first-class versioned product surfaces (per spec §1). Extraction later = swap the transport (in-process call → network call) behind the *same* contract; the contract does not change.

**D4 — Extractability is continuously verified, not assumed.** D2 (the build fails on a boundary breach) + D3 (the contract is Pact-tested every PR) together mean the Pipeline is provably extractable at any commit. "We can extract it later" is never a comfortable lie — it is a property the CI asserts.

**D5 — The lib partition is drawn deliberately, including the boundary libs.** Most libs bucket obviously: intelligence (`sourced_candidate`, `talent_trust`, `identity_index`, TR-2…TR-15) = **Pipeline**; `engagement`, `submittal`, `examination`, `talent_record`, outreach = **ATS**. A few libs sit *on* the L3 boundary and require deliberate placement, not a reflexive bucket:
- **`canonicalization`** — the promotion gate (Pipeline → ATS hand-off). It is *the seam*, so it lives at the boundary and is exactly where the connector contract runs.
- **`consent`** — the legal layer that spans (keyed to L3 TalentRecord, but a Pipeline/compliance concern).
These are placed when I15 is implemented (the boundary audit, §4), not assumed here.

## 3. The forcing function — when physical extraction DOES happen (the other guardrail)

Just as "extract now" is premature, "never extract" would let the wedge die. Physical extraction (own repo + own DB + own deployable) happens **when, and only when, a concrete forcing function exists** — so the decision is driven by reality, not by either impulse:

- **A real tier-3 customer** — the first Pipeline-only customer who needs the Pipeline deployed into *their* ATS environment (Bullhorn/Workday/etc.), which genuinely requires the Pipeline to run as its own deployable; **or**
- **An independent-scaling or independent-deployment need** — the Pipeline must scale, release, or be operated separately from the ATS for a real operational reason.

Absent a forcing function, the Pipeline stays in the monorepo (D1). **"Tier-3 might exist someday" is NOT a forcing function.** When a forcing function arrives, the extraction is *mechanical* — because D2/D3/D4 made the boundary battle-tested — not a rewrite. The *business* read of "is the forcing function real yet" is the PO's call; the *technical* guarantee is that whenever the call is made, extraction is a transport swap, not a rebuild.

## 4. Implementation & timing

**Timing (ruled):** I15 + the contract-first seam are locked at the **realignment/TR-2 seam** — a small "step 6.5," *after* the Architecture Realignment milestone closes (Core retired, husk torn down, boundaries stable) and *before* TR-2's first commit. Rationale: the realignment is still moving libs (Core retiring); drawing the wall mid-teardown means redrawing it. But TR-2 is precisely the work that would benefit from the wall being enforced from its first commit (every TR-2 increment is a chance to accidentally couple intelligence to the ATS). So: realignment cleans the coupling → I15 + contract-first locks it → TR-2 builds against the enforced boundary → extract when forced.

**Step 6.5 work items:**
1. **Boundary audit** — verify (grep + nx graph) that no Pipeline lib hard-imports an ATS lib today. (Believed clean — UUID refs only — but *verified*, not assumed.)
2. **Partition** — assign every lib to Pipeline / ATS / boundary per D5, with the boundary libs (`canonicalization`, `consent`) deliberately placed.
3. **I15 enforcement** — nx boundary tags + the depConstraints rule; CI fails on a Pipeline→ATS import. Add a negative-control test (an injected violating import trips the build), the way 4a proved I14.
4. **Contract-first seam** — make the L3 connector contract a first-class, Pact-tested interface the Pipeline talks through in-process.
5. **Spec** — add I15 to §8; note the modular-monolith-extract-when-forced posture in §1.

## 5. Consequences

**Positive.** Portability is build-enforced, not aspirational. The moat product stays in-process and fast (no distributed-systems tax paid for an unbuilt tier-3). The Pipeline is provably extractable at any commit. TR-2…TR-15 build against an enforced boundary, so coupling cannot creep back. Extraction, when forced, is mechanical (transport swap behind a stable contract).

**Costs / accepted trade-offs.** The Pipeline and ATS share a repo and a database instance (separate schemas) until a forcing function arrives — accepted, because logical decoupling delivers the portability and physical separation would tax the moat. Discipline is required on every PR (mitigated: CI enforces it, so the discipline is the build's, not the author's memory).

**Invariants:** adds **I15**; consistent with I1 (UUID-only cross-schema, no FK) and I14 (the `identity_index` PII/tenant boundary). No invariant relaxed.

## 6. Status

**ACCEPTED / LOCKED / PO-ratified.** This is a binding build-time ruling; directives and Claude Code follow it without re-litigation. Superseding it requires a new ADR. I15 is enforced in CI from step 6.5 onward.

## 7. Identifier-correction record (G-REC-1, 2026-08-09)

- **OLD:** provisional **ADR-0017** (Pipeline Boundary / Modular Monolith), self-flagged provisional at authoring (2026-06-30).
- **NEW:** **ADR-0029** (this record).
- **UNCHANGED:** the architectural decision (D1–D5, forcing function, I15).
- **PRESERVED:** **ADR-0017 = RDS Disaster Recovery Strategy** (incumbent, registered, indexed) — untouched.
- The provisional ADR-0017 Pipeline artifact is retained in the canonical store (OneDrive `Aramo/locked/`) as historical evidence with an identifier-supersession stamp. Historical/immutable references are not rewritten merely to erase the old identifier.
