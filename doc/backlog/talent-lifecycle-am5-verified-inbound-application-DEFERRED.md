<!--
Filed to doc/backlog by the Code Executor on PO instruction (2026-10-21: "AM-5 LOCKED and
deferred will be buried, so please add this to a docs/backlog folder so we can track").
STATUS: BACKLOG — DEFERRED. NOT implementation authorization.
-->

# AM-5 — A verified inbound application establishes Contacted (R3) — DEFERRED

| Field | Value |
|---|---|
| Status | **LOCKED product authority — implementation DEFERRED** (deferred, not canceled) |
| Product ruling | PO ruling R3 (Talent Lifecycle R1–R5) |
| Product authority | `Aramo-Talent-Lifecycle-R1-R5-Amendment-A1-Dispositions-and-Superseding-Amendments-v1_0-LOCKED.md` §6 (AM-5), SHA `0579e909…` |
| Deferral authority | `Aramo-Talent-Lifecycle-R1-R5-Implementation-Directive-v1_2-LOCKED.md` §1.2 and §8 (Lead rulings L-7 Option 2, L-8 DEFER), SHA `5745d8dc…` |
| Unblocked by | The verified-application-source milestone **SRC-2**, plus a separate PO authorization |
| Not delivered by | PR #994 (Talent Lifecycle R1–R5 S0–S4) |
| Tracking rule | The R1–R5 program **must not be reported as complete** while this item is open |

## What AM-5 says (A1 §6, summarized)

- **Contacted** means a durably evidenced interaction about this opportunity exists. That is either an executed recruiter→Talent contact, or a **verified inbound application to this exact requisition, accepted by a recruiter**.
- **Verified association (D-7).** The application evidence itself must carry the requisition association. An example is a posting identifier that resolves, through a governed mapping, to exactly that requisition in that tenant. A requisition the recruiter picks by hand is not verification.
- If the association cannot be verified, the arrival stays an ordinary sourcing arrival: `no_contact`, sourcing provenance, no application evidence.
- **Acceptance.** A recruiter reviews and accepts the verified application. The Pipeline entry is then created at `contacted`, with application provenance (`INBOUND_APPLICATION` or `CAREER_SITE`) and evidence kind `inbound_application` referencing the durable application record. No outbound communication record is created or implied.
- An unsolicited or general inquiry without verified evidence about a specific requisition never creates a Pipeline entry or transition.
- An application never establishes **Talent responded**.
- AM-1 applies: acceptance is refused on `closed` or `canceled` requisitions.
- First slice: only sources that carry a verifiable requisition association. Career site and portal intake are later slices.
- Acknowledgement messages to the Talent are a separate, configurable enhancement and are not part of AM-5.

## Why it is deferred

No inbound source today can meet the D-7 verification bar:

- The Indeed apply webhook parses 4 fields and 0 job identifiers (`apps/api/src/webhooks/indeed-apply.service.ts:41-46`, `:189-194`). It cannot name a requisition.
- The nearest governed mapping, `job_distribution."ChannelPostingState"` (`libs/job-distribution/prisma/schema.prisma:45`), has no reverse-unique index on `external_posting_id`. A posting id cannot be resolved back to exactly one requisition.
- Building AM-5 now would mean advancing to Contacted on an association nobody verified — the speculative advance S4 removed elsewhere.

## Facts carried for the future work (v1.2 §8, G-C)

- The Lane2-B birth-row reconciliation is DV-1.
- The `CAREER_SITE` system-actor projection is DV-2.
- The accept-route scope (L-8) is reassessed then. `pipeline:add` is one option, considered only after a fresh authorization review.
- A draft addendum for application acceptance (S5-A) exists in OneDrive `drafts/TALENT-LIFECYCLE-R1-R5/…-v1_2-Addendum-A1-S5A-Application-Acceptance-v1_0-DRAFT.md`. It is a draft only.

## What delivering it involves (not authorized)

- A durable, tenant-scoped, verified application record.
- A governed posting → requisition mapping that resolves to exactly one requisition.
- A recruiter accept route that creates the Pipeline entry at `contacted` in one transaction.
- `INBOUND_APPLICATION` provenance and the `inbound_application` evidence kind (adding it to the per-stage evidence allowlist for `contacted` only, `libs/pipeline/src/lib/evidence-admissibility.ts`).
- Erasure classification for the new application table (S2 erasure integrity).
- OpenAPI documentation for the new routes.

## Exit criteria

1. SRC-2 delivers a signed apply payload carrying a resolvable posting identifier.
2. The Lead reviews and the PO locks an implementation directive or addendum.
3. The PO separately authorizes the build.
