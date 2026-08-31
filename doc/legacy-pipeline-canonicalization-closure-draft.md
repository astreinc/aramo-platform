*Aramo — Legacy Pipeline Canonicalization Closure Record — DRAFT (pending PO ratification)*

**ARAMO**

*Talent Intelligence and Entrustment Platform*

**Legacy Pipeline Ontology Eradication / Canonicalization — Closure Record**

*Governance close-out of the Pipeline status-model reduction from 13 values to the canonical 7, and the supersession of Lane2-DDR SB-1.*

**VERSION 1.0 — DRAFT (pending PO ratification)**

Classification: Internal — Aramo Program

> **Note on status.** Markdown working draft produced by Gate 5 of the Legacy
> Pipeline Canonicalization slice. Post-merge, per the closure-record convention,
> this is filed at the canonical OneDrive location as
> `Aramo-Legacy-Pipeline-Canonicalization-Closure-v1_0-LOCKED.docx`. The PO
> ratifies via the §6 block. Substrate basis: `origin/main` at `1b204b58`.

# 1. Purpose

This record documents the deliberate eradication of the retired legacy Pipeline
status ontology from runtime/product code, and the governance supersession of
Lane2-DDR SB-1. Following a zero-production-row proof and an explicit PO/Architect
decision, the Pipeline enum is reduced from 13 values to the canonical 7. Git and
migration history retain the removed ontology; current code describes only the
current system.

# 2. The canonical Pipeline ontology (locked to 7)

The Pipeline owns **recruiting progress only**. Everything past `qualified`
(client submittal, interview, offer, placement, assignment) is owned by its
downstream aggregate and is **never** a Pipeline status.

```
no_contact
contacted
talent_responded
qualifying
qualified
not_in_consideration      (recruiter disposition terminal)
completed                 (system-only success terminal)
```

The only recruiter mutations are `CONTACT`, `MARK_RESPONDED`,
`START_QUALIFICATION`, `QUALIFY`, `DISPOSITION`. `COMPLETE` remains system-only.

# 3. Removed values (eradicated, not remapped)

`no_status`, `submitted`, `interviewing`, `offered`, `client_declined`, `placed`
— removed from: the Prisma enum + database enum (type-swap migration), the
`pipeline-state.ts` registries + transition matrix, the partial live-episode
index predicate, DTOs/contracts, the FE hand-mirror + ribbon + guards, reporting
reads, the seed, tests/fixtures, and current-state documentation.

Their owners:
- `submitted` → Submittal (`submitted_to_ats`)
- `interviewing` → Client-Selection / InterviewSession
- `offered` → Offer aggregate
- `placed` / `client_declined` → PlacementProcess / Client-Selection outcome
- `no_status` → had no in-repo producer (import-legacy ballast)

**One deliberate non-removal (divergence, reported).** The error code
`PIPELINE_SUBMIT_REQUIRES_SUBMITTAL` — the former bare-pipeline `→ submitted`
refusal — has **no throw-site** and is definitionally about the eradicated
`submitted` value, but it is **retained as COMPATIBILITY_RESERVED**, not deleted.
The error-code registry is **append-only** by standing law (dropping a code risks
the merge-window append-conflict class); the machine-governed `RESERVED_CODES`
mechanism in `ci/scripts/verify-dead-error-codes.ts` is the sanctioned way to carry
a retired code. It is therefore classified **HISTORICAL_REQUIRED**, not REMOVE_NOW,
with its reservation reason updated to note the enum value is now fully gone. This
is the single point where the "zero residue across all layers incl. error-codes"
directive line is honored by reservation rather than deletion.

# 4. Zero-row proof (destructive-conversion precondition)

Per the explicit decision to **eradicate without historical remapping**, the
destructive enum conversion was gated on a pre-mutation census proving zero rows
carry any removed value, in BOTH the live `Pipeline` table and the append-only
`PipelineStatusHistory` table.

```
PRE-MUTATION CENSUS (prod, read-only)
  live rows in any of the six retired values         = 0
  history rows (status_from/status_to) in any retired = 0
```

Because the census was clean, the migration `USING status::text::PipelineStatus_new`
cast is a straight cast with **no remap** — no `submitted → qualified`,
`placed → completed`, or any historical translation was performed. The cast fails
loud if a row unexpectedly holds a removed value.

# 5. SB-1 supersession (governance integrity)

Lane2-DDR **SB-1** deliberately required the live-slot exclusion set to be the
four members `not_in_consideration`, `completed`, `placed`, `client_declined`,
and retained the legacy enum values "for history, no restamping." That decision
was **correct** while legacy Pipeline rows remained a supported compatibility
possibility.

**Supersession.** Following the zero-production-row proof and the explicit
PO/Architect decision to eradicate the legacy Pipeline ontology, `placed` and
`client_declined` cease to exist as Pipeline statuses. The live-slot exclusion
set therefore collapses to the two canonical terminals:

```
CANONICAL_TERMINAL_STATUSES        = { not_in_consideration, completed }
LIVE_EPISODE_EXCLUSION_STATUSES    = { not_in_consideration, completed }
```

The partial live-episode index predicate becomes:

```sql
WHERE status NOT IN ('not_in_consideration', 'completed')
```

There is no longer a `LEGACY_TERMINAL_STATUSES` registry: the removed ontology is
remembered by git and migration history, not by runtime code. SB-1's four-member
decision is not erased — it is recorded here as superseded, with the reason.

# 6. §6 PO ratification

- [ ] PO ratifies the Legacy Pipeline Canonicalization closure and the SB-1
  supersession. Signature: __________________ Date: __________
