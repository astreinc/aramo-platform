<!--
Filed to doc/backlog by the Code Executor on PO instruction (2026-11-02: "You can create a
backlog for this gap now and add it to the doc/backlog to pick up later").
STATUS: BACKLOG / DEFERRED — NOT implementation authorization.
-->

# ATS: send any ATS-tagged document template (DEFERRED)

| | |
|---|---|
| Status | **Deferred by PO decision, 2026-11-02**, while scoping the template product program (platform delete, product-tag enforcement, more document types). Revisit when the focus is on ATS. |
| Baseline | `origin/main` `0da8273e` (recon 2026-11-02). |
| Governing today | ADR-0034 (D9 product tags), TEMPLATE-STUDIO-1, ORG-UX-1. The template product program directive will make product tags enforced; this item is the ATS half it leaves out. |

## 1. The gap

Platform Admin will be able to publish document types beyond Right to Represent (NDA, lease, …),
each tagged with the products it applies to (`ats`, `sign`, or both). A tenant adopts a default,
edits it and approves it, then uses it in the tagged products.

In Aramo Sign that works end to end: the Sign Templates page lists every usable template.

**ATS has no way to send one.** The only template-driven send in ATS is the dedicated Right to
Represent flow:

- `apps/ats-web/src/rtr/SendRtrModal.tsx`, `SendRtrLauncher.tsx`, `RtrPanel.tsx`
- backend `apps/api/src/rtr/` (resolver, orchestrator, binding, letterhead), hard-wired to the
  RTR document type and its `rtr-html-v1` content contract.

The offer letter has its own send flow, but it uses inline content, not a template
(`apps/api/src/offer-document/offer-document-orchestrator.service.ts`; PLATFORM-UX-1 F-8).

So a template tagged `ats` (alone or with `sign`) that is not Right to Represent has **no ATS entry
point**. Examples:

| Default | Tags | Works in Sign | Works in ATS |
|---|---|---|---|
| Right to Represent | `ats`, `sign` | Yes | Yes (Send RTR) |
| NDA | `ats`, `sign` | Yes | **No** (this gap) |
| Lease | `sign` | Yes | Not intended |
| Any new ATS-only type | `ats` | Not intended | **No** (this gap) |

PO position (2026-11-02): acceptable for now. Platform Admin should not publish an ATS-only
type until this item ships, because recruiters would have no way to send it.

## 2. What closing it looks like (for the future directive; not decided)

A general **Send document** action on the talent record (and possibly on a submittal or
requisition), replacing nothing:

1. The recruiter picks from the tenant's active templates tagged `ats` (any document type).
2. ATS fills the variables it knows (talent, requisition, client, recruiter, organization); the
   recruiter fills the rest.
3. The recruiter chooses the signers per the template's signing roles, previews, and sends.
4. The sent document is tracked on the talent record (status, reminders, the signed copy), with the
   same evidence and audit as Right to Represent.

Questions for that directive:

- Does Right to Represent fold into the generic action, or keep its own button?
- Which ATS contexts carry it (talent, submittal, requisition, offer and start)?
- Do sent documents count as recruiting evidence or pipeline milestones (cf. the
  `PIPELINE_STAGE_REQUIRES_EVIDENCE` rules)?
- Does sending go through Aramo Sign envelopes (as Right to Represent does) for every type?
- Does the binding generalize per document type, or per variable from the platform variable
  catalog (`TemplateVariable`, `ats_binding_key`)?
- How do fixed legal forms (I-9, W-4) reach ATS: through this action, or through onboarding?

## 3. Substrate notes (recon 2026-11-02)

- 30 non-test files hard-code Right to Represent (type id `d0c50005-0000-7000-8000-000000000001`,
  `rtr-generated-v1` / `rtr-html-v1`, `RTR_BINDING_CATALOG`). Configurability is the single switch
  `apps/api/src/rtr/rtr-template-capabilities.service.ts` (`isConfigurable`).
- Seeded SYSTEM types with no send code today: `CLIENT_NDA`, `BACKGROUND_AUTHORIZATION`, `I9`
  (`libs/documents/prisma/migrations/20261005120000_offer_start_seed_prestart_document_types`).
- The ATS template lookup (`apps/api/src/rtr/rtr-template-resolver.service.ts` →
  `libs/documents/src/lib/template-resolution.service.ts`) lives in `apps/api` + `libs/documents`;
  adding a product filter or a second consumer creates no new nx dependency edge.
