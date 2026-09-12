# Backlog — Work-history edit: audit trail + provenance / genuine-profile signal

**Type:** Backlog (design follow-up; no directive blocking the current slice).
**Raised by:** PO (Purush), 2026-09-12.
**Status of the shipping slice:** Work-history **is editable now** on the Add-Talent
full-profile edit via **replace-set** (PO-authorized). This doc records the known
tension the replace-set introduces and the follow-up work to resolve it properly.

---

## Decision shipped (now)

The full-profile edit (Talent → detail → Edit profile → Edit full profile) lets the
recruiter edit **key_skills AND work-history**, because a returning talent's profile
(skills, roles) genuinely changes over time and arrives refreshed from upstream
(channels, sourcing platforms, a new résumé). Blocking work-history edits would fight
how the data actually flows in.

Mechanism (shipped):
- `PATCH /v1/talent-records/:id` accepts `work_history[]`.
- `TalentExtractionService.replaceDeclaredWorkHistory` → `TalentEvidenceRepository.replaceWorkHistoryForTalent`:
  an **atomic** delete of the talent's `source='resume'` work-history rows + recreate
  of the reviewed set (scoped to `source='resume'` so rows from other source
  channels are untouched). Declared, not verified.
- Absent `work_history` on the PATCH = work-history untouched (scalar-only edit, e.g. the
  quick-edit drawer).

## The tension (why this is a backlog item, not "done")

`libs/talent-evidence` is a deliberately **closed create+find surface** — its repository
guard forbids `update`/`delete` methods; evidence is conceptually **append-only and
immutable** ("evidence created cannot be changed"). `replaceWorkHistoryForTalent` is the
**one sanctioned mutation** (named `replace`, enumerated in the surface guard), and it
**destroys** the prior rows. Consequences we are knowingly accepting for now:

1. **No history of the prior work-history.** A replace loses what was there before — there
   is no audit trail of who changed what, when, or what the upstream-sourced value was.
2. **Row ids are re-minted on each edited save.** The trust-ledger reconcile
   (`routeDeclaredEvidenceToLedger`) uses the work-history row `id` as its `source_ref`
   for idempotency. Re-minted ids → on the next examine/backfill the reconcile can emit
   **new CLAIMS** for the same employment (the old source_refs no longer exist), i.e. the
   ledger can accrete duplicate-ish claims across edits. (The FE mitigates churn by
   sending `work_history` only when the recruiter actually touched the section — an
   untouched edit leaves the rows alone — but any genuine edit still re-mints.)
3. **Provenance drift is invisible.** When a recruiter edits work-history that originally
   came from an upstream channel / résumé, we currently have no signal that the declared
   value has diverged from its sourced origin.

## Follow-up work (to design later)

- **Audit / change history for work-history** — either append-+-supersede (keep prior
  rows with a `superseded_at`; the detail read filters them; needs a migration) or a
  dedicated change-log. Preserve "what the upstream said" vs "what the recruiter set".
- **Genuine-profile / trust signal on edited-away-from-source evidence** — when declared
  work-history (or skills) is edited away from its sourced origin, reflect that in the
  profile's trust / "genuine profile status" surface and **notify** appropriately
  (per PO: "we later think how to keep audit or finding if those get changed and will
  notify on the genuine profile status").
- **Stabilize the ledger `source_ref` across edits** — so a work-history edit does not
  silently create duplicate ledger claims (e.g. key the source_ref on a stable logical
  identity rather than the re-minted row id, or reconcile-with-supersede).

## Pointers

- Repo mutation: `libs/talent-evidence/src/lib/talent-evidence.repository.ts` →
  `replaceWorkHistoryForTalent` (+ surface guard enumeration in
  `libs/talent-evidence/src/tests/talent-evidence.repository.spec.ts`).
- Service: `libs/talent-extraction/src/lib/talent-extraction.service.ts` →
  `replaceDeclaredWorkHistory`.
- Controller: `libs/talent-record/src/lib/talent-record.controller.ts` → `update()`.
- Ledger reconcile that consumes the row id as `source_ref`: same service →
  `routeDeclaredEvidenceToLedger`.
