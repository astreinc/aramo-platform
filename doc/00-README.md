# `doc/` — Aramo Program Communication Layer

This folder is the **persistent shared context** for everyone executing on Aramo.

It exists because Aramo is built primarily by Claude Code instances under Lead Engineer review. Claude Code instances do not retain memory across PRs. Lead Engineers cannot manually communicate every architectural decision to every PR. The `doc/` folder is the mechanism that propagates context across parallel work streams.

---

## Who reads this folder

- **Claude Code instances** — read relevant `doc/*.md` files at the start of every prompt before generating any code
- **Lead Engineers** — read this folder to verify Claude Code output preserves design discipline; update files when decisions are made
- **Architect** — owns the discipline of this folder; reviews substantive changes
- **PO and BA** — reference for product and domain alignment

---

## The protocol (mandatory)

**Every Claude Code prompt for development work must include:**

1. Explicit reading of relevant `doc/*.md` files at the start
2. Reference to the locked specs the PR derives from
3. Confirmation of refusal commitments that touch the code path

**No PR is reviewable until the prompt establishes this context.**

This is not optional. Skipping the protocol produces drift across the codebase that compounds invisibly.

---

## Reading order for new Claude Code instances

A Claude Code instance new to the program should read in this order:

1. `00-README.md` (this file) — what `doc/` is
2. `01-locked-baselines.md` — what's locked, where to find it
3. `02-claude-code-discipline.md` — how to work in this program
4. `03-refusal-layer.md` — what the system will not do
5. `04-risks.md` — failure modes specific to this team model
6. `05-conventions.md` — code-level patterns and naming
7. `07-prompt-template.md` — how to structure new PR prompts
8. `adr/README.md` — ADR conventions and how decisions are
   documented; followed by individual ADRs (`adr/0001-*.md`,
   `adr/0002-*.md`, etc.) that capture decisions not locked in
   Charter / Group 2 / Architecture / API Contracts

`06-lead-review-checklist.md` is for Lead Engineers, not Claude Code. Claude Code instances do not need to read it but may reference it to understand what their output will be reviewed against.

---

## File mutability

Some files are mutable; some are not.

**Immutable (do not modify without Architect approval):**
- `00-README.md` — the protocol itself
- `01-locked-baselines.md` — pointer to locked specs (only changes when a baseline locks or relocks)
- `03-refusal-layer.md` — refusal layer is Charter-locked

**Mutable (Lead Engineers update as patterns emerge):**
- `02-claude-code-discipline.md` — discipline rules sharpen with experience
- `04-risks.md` — risks accumulate as new failure modes are discovered
- `05-conventions.md` — code conventions evolve as patterns stabilize
- `06-lead-review-checklist.md` — review depth calibrates to reality
- `07-prompt-template.md` — template improves with use
- `adr/` — ADR folder. New ADRs are added as decisions are made;
  existing ADRs are immutable once Status: Accepted (a
  superseding decision creates a new ADR with Status: Supersedes
  ADR-NNNN, rather than editing the old one)

When mutable files are updated, the change is recorded in the file's "Revision History" section at the bottom.

---

## What this folder is not

- **Not the locked specs.** Charter, Group 2, Architecture, and API Contracts are the source of truth. This folder references them but does not reproduce their content.
- **Not a wiki.** This folder is read by Claude Code instances; it must be operationally precise, not exploratory.
- **Not a status tracker.** Milestone progress lives elsewhere (Jira, GitHub Projects, etc.). This folder is about discipline, not status.
- **Not optional.** Skipping doc updates is a discipline violation that compounds across the program.

---

## When to update this folder

Update `doc/*.md` files when:

- A new pattern is established and Claude Code instances need to know about it
- A new risk is discovered (drift incident, refusal violation, schema mismatch)
- A convention changes (naming, file organization, error handling)
- A Lead review checklist needs sharpening (a PR almost merged with a defect that wasn't caught)

Do not update when:

- A specific PR introduces a unique decision (that belongs in the PR description)
- Documenting an experiment that may not become permanent
- Clarifying something a single Claude Code instance got wrong (sharpen the prompt template instead)

---

## Document hygiene

Every file in this folder must:

- Be written for Claude Code as primary reader
- Use concrete examples ("Do X / Never do Y") not abstract principles
- Reference locked spec sections by section number, not by paraphrase
- Be reviewable in under 5 minutes by a Lead Engineer

If a `doc/*.md` file exceeds 800 lines or takes longer than 5 minutes to review, it has become a wiki page. Split it.

---

## Revision History

| Date | Change | By |
|---|---|---|
| 2026-04-27 | Initial seeding | Architect |
| 2026-04-28 | Added `adr/` reference to Reading order and File mutability | Architect (acting Lead) |
