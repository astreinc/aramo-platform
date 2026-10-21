# ADR-0034 — Shared Document Template Library: Aramo Defaults and Tenant Templates

**Status:** ACCEPTED (2026-10-20). Lead Architect disposition: **APPROVED WITH IMPLEMENTATION SAFEGUARDS**, D1–D12 approved (see §8). PO rulings are captured from the 2026-10-20 session.
**Date:** 2026-10-20
**Deciders:** PO (product rulings), Lead/Architect (technical ruling and lock)
**Baseline:** `origin/main` `5a96f65b`
**Related LOCKED:**
- `Aramo-DOC-Documents-and-Native-ESignature-Architecture-and-Build-Directive-v1_1`
- `Aramo-DOC-2-Templates-Rendering-Requirements-Slice-Directive-v1_0`
- `Aramo-DOC-TEMPLATE-ADMIN-RTR-1-Tenant-Document-Template-Administration-RTR-Governed-Template-v1_0`, with Amendments A1 and A2
- `Aramo-RTR-TEMPLATE-1`
- ADR-0020 (build for tenant #50)
- ADR-0029 (Pipeline⊥ATS wall)

## 1. Context

Documents that need signing, such as the offer letter and the RTR, are built from **document templates**. Today:

- **Templates already live in the shared Documents domain, not in ATS.** The models `DocumentTemplate`, `TemplateVersion`, `TemplateFieldDefinition` and `TemplateAsset` are in `libs/documents/prisma/schema.prisma:223-330`, in schema `documents`, with nx tag `scope:boundary`.
- **Every template belongs to exactly one tenant.** `DocumentTemplate.tenant_id` is `NOT NULL`, with an optional `client_id`. Aramo has no level shared across tenants.
- **`DocumentType` already has an Aramo-wide level.** Its scope is `SYSTEM | TENANT | CLIENT`, with a nullable `tenant_id` (`schema.prisma:30-36`). This ADR extends the same pattern to templates.
- **Template administration is tied to ATS.**
  - Permission: `document_template:{read,manage}` is granted only to the ATS roles `tenant_admin` and `tenant_owner` (`libs/identity/prisma/seed.ts:2835-2836`).
  - Screen: the editor lives in ATS Settings (`apps/ats-web/src/settings/documents/DocumentTemplatesSection.tsx`).
  - Sign has separate permissions, `sign:template:{use,manage}`, that are seeded but unused, and its Templates page is labelled "Future capability".
- **The variables a template may contain are defined per document type in code.** This is the template capabilities port, `libs/documents/src/lib/template-capabilities.port.ts`. RTR is the only type that can be configured today.
- **Locked versions already exist.** A version is frozen once activated (Invariant 5, with a DB trigger), and activation is gated on a preview.
- **Sign never reads the `documents` schema directly.** It fetches frozen document bytes over signed service-to-service HTTP (`apps/sign-service/src/app/document-source-http.adapter.ts`).

**Problem.** Common documents (offer letter, NDA, RTR, lease and so on) should be usable by every Aramo tenant: ATS, Sign, both, or a personal account. Tenants must not each maintain their own copy of a standard text. Tenants who need their own wording must be able to have it, and must own it legally.

## 2. Decision

### D1. One template library, two owners
- **Shared home:** all document templates live in the Documents domain (`libs/documents`). No product keeps a template store of its own.
- **Two owners:**
  - **Aramo default (PLATFORM):** written and maintained only by the SaaS platform admin.
  - **Tenant template (TENANT):** created and owned by one organization.
- **Personal accounts** are tenants (`Tenant.kind = PERSONAL`) and follow the TENANT rules. They get no separate level.

### D2. Defaults are written in Platform Admin; tenants can't edit them
- **Authoring surface:** defaults are created, versioned, published and withdrawn only in **Platform Admin** (`admin.aramo.ai`, consumer `platform`).
- **No tenant edits:** no tenant role can edit a default.
- **Tenant access:** tenants see and use defaults in **Org / App Home**.

### D3. "One template, always latest": users see only the current version
- **Users see one version:** each default is a single template to users, and tenants see and use only its **current** published version.
- **The system keeps every past version.** Each generated or signed document records the exact version it was built from. A document already filled in or sent on v3 stays on v3 after v4 is published. This is the existing locked-version behaviour (DOC-2 Invariant 5) and needs no change.
- **"Updated {date}" badge:** the default's card in the gallery shows when it was last updated.

### D4. Tenants can use a default without copying it
- **Rendering with tenant data:** a tenant uses a default directly, rendered with their own data (D7 variables) and their own branding (D8).
- **No tenant row:** using a default creates no template row for the tenant.

### D5. "Create your own document template", with no copy function
- **No copy:** per PO ruling (2026-10-20), there is **no Copy & Edit and no copy function**. A tenant that wants its own version **creates a new template**: the Org Home action is **"Create your own document template"**.
  - The new template is a **TENANT** template for a chosen document type. It is written from scratch or built on the tenant's own uploaded document (UPLOADED_PDF / HYBRID).
  - It is never pre-filled from an Aramo default. That would be a copy under another name.
- **Legal ownership:** the content is the tenant's own and belongs to the tenant legally from the start.
- **No link and no provenance:**
  - The tenant template stores no reference to any default.
  - Its audit trail records an ordinary "template created" event, with no "copied from".
  - Aramo never pushes changes into it, and it shows no "new Aramo version available" prompt.
- **Coexistence:** the Aramo default stays available to the tenant alongside their own template.

### D6. Approval and the active template per document type
- **Creating and approving:** a **tenant admin or owner** (`tenant_admin` / `tenant_owner`, organization-level per D11) creates and approves tenant templates. One person may do both.
- **Preview before approval:** the existing gate stays in force. A version can only be activated after an admin has previewed its current content.
- **Active choice per document type:** each tenant has an **active choice per document type**, optionally **per client**. The choice is either "Aramo default" or "tenant template X".
  - **Which choice applies:** product flows such as ATS **Send RTR** or **Send Offer**, and Sign "start from template", use the most specific choice that applies: client first, then tenant, then the Aramo default. They never ask the user.
  - **Approval switches it:** approving a tenant template sets it as the active choice for its type (and client, if one is set).
  - **Switching back:** the tenant admin or owner can switch back to the Aramo default at any time.
- **Tenant template versions** follow the existing cycle: DRAFT, then preview, then ACTIVE, then RETIRED.

### D7. One Aramo-maintained catalog of variables
- **Fixed by Aramo:** the variables in a template (talent name, pay rate, start date, organization name and so on) come from **one catalog maintained by the SaaS owner** in Platform Admin.
- **Who can change the catalog:** only the SaaS owner can add or update catalog entries.
- **What a tenant template can do with variables:** a tenant template may rearrange text and the variables it already has. It may add only variables from the catalog.
- **Filling variables:**
  - **ATS:** catalog variables are filled automatically from ATS data.
  - **Sign:** any variable the product can't fill becomes a field the sender completes when creating the envelope.
- **Replacing the code-defined port:** the catalog replaces the per-type variable lists now defined in code in `template-capabilities.port.ts`. The port keeps its role of validating content and producing previews.

### D8. Defaults carry tenant branding
- **What is applied:** when a default is rendered, it takes the tenant's logo and organization details from the tenant profile and tenant assets.
- **Why:** tenants should never need to create their own template just to add their branding.

### D9. Product tags on defaults
- **Tags:** each default is tagged with the products it applies to, for example `ATS` (RTR) or `SIGN` (lease).
- **Not enforced in the first increment:** per PO ruling ("not controlled now"), the tags are recorded but don't yet hide anything. Every tenant sees every default.
- **Later:** filtering by subscription, and the "Sign set" for personal accounts, come in a later increment.

### D10. Withdrawing a default: notice and fallback
- **Withdrawal is announced:** when the platform admin withdraws a default, every tenant whose active choice uses it gets a **notice** with an effective date: **7 days** after the notice by default, configurable by the SaaS owner per withdrawal.
- **Fallback at the effective date:** the active choice for that type and client moves to the tenant's approved template for that type, if there is one. If there isn't, the flow asks the tenant admin or owner to choose. Sending never falls back silently to a different text.
- **Past documents are unaffected:** documents already generated stay on their recorded version.

### D11. Template administration moves out of ATS
- **New home:** tenant template administration (gallery, create, edit, approve, active choices) moves to **Org / App Home**, behind a **product-neutral** permission.
- **Who gets it:** the permission is granted to **`tenant_owner` and `tenant_admin`** as **organization-level** roles.
  - **PO ruling (2026-10-20):** "tenant_admin/tenant_owner should live at the org level and Admin/Owner for all the product of that tenant."
  - **Today's code differs:**
    - `tenant_owner` and `tenant_admin` are ATS product roles (`ATS_PRODUCT_ROLE_KEYS`, `libs/identity/src/lib/dto/role.dto.ts:131-145`).
    - The only product-neutral role is `org_admin` (IC-3 PR-7).
  - **PO ruling (2026-10-20, follow-up):** "tenant_admin, org_admin is duplicate. tenant_admin is NOT ats_admin ONLY (he is tenant admin)." So `org_admin` merges into `tenant_admin`, the organization-wide admin.
  - **Separate decision needed:** changing the role model is out of scope for this ADR. It is decided in ADR-0035 (organization and product role model; see O-6).
  - **Until then:** this ADR assumes the template-admin permission is part of the organization-level permission set that Owner and Admin hold.
- **ATS and Sign** keep only the "use" side and link to Org Home for management.
- **Retired screen:** the ATS Settings document-templates section is retired once Org Home has the same functionality.

### D12. Sign uses the library through the Documents API
- **API only:** Sign lists, previews and renders templates only through the Documents API over the existing signed service-to-service channel.
- **No schema access:** Sign still never touches the `documents` schema directly.

## 3. Data model sketch (non-binding; the implementing directive decides)

| Change | Notes |
|---|---|
| `DocumentTemplate.owner_scope` `PLATFORM \| TENANT` | `tenant_id` becomes nullable **only** when `owner_scope = PLATFORM` (DB CHECK). `client_id` must be NULL for PLATFORM rows. |
| `DocumentTemplate.products text[]` | PLATFORM rows only (D9). |
| `TemplateVersion` for PLATFORM rows | Same lifecycle and immutability. "Current" is `current_version_id`. Tenants may resolve only the current version (D3). |
| New `TenantTemplateSelection` (`tenant_id`, `document_type_id`, `client_id?`, `template_id`) | Unique on (tenant, type, client). No row means the Aramo default applies (D6). |
| Withdrawal fields on PLATFORM templates (`withdraw_notice_at`, `withdraw_effective_at`) | D10. |
| New `TemplateVariable` catalog (key, label, group, data type, products, ATS binding key, safe sample value) | Maintained in Platform Admin (D7). It supersedes the per-type lists defined in code. |
| Existing tenant RTR templates | Already TENANT rows. Migration creates a `TenantTemplateSelection` for each currently active one, so behaviour doesn't change. |

## 4. Rules that must hold

1. **Reads include defaults explicitly:** every tenant read of templates explicitly includes `tenant rows (tenant_id = :tenant) ∪ PLATFORM rows`. No query may treat `tenant_id IS NULL` as "match any tenant" by accident.
2. **Platform rows are written only from Platform Admin:** PLATFORM rows are written only through the Platform Admin surface, with platform-tier authorization. A tenant-consumer token can never write one.
3. **No personal data in defaults:** PLATFORM templates hold no PII. The S2 erasure write-guards and the erasure ledger don't apply to them, and any guard on the `documents` tables must accept rows with a NULL `tenant_id` only when `owner_scope = PLATFORM`.
4. **Signed documents point at an exact version:** a generated or signed document always references an exact `template_version_id`, never "latest".
5. **Allowed wording:** user-facing copy uses only allowed terms (`scripts/verify-vocabulary.sh`).

## 5. Consequences

**Positive**
- One source of each standard text. Copies exist only when a tenant deliberately takes ownership.
- ATS, Sign and personal accounts share one gallery, one editor and one approval flow.
- Clear legal boundary: a default is Aramo's content, provided as-is; a tenant-created template is the tenant's own content and responsibility.
- Most tenants never need their own template, because of automatic branding (D8) and catalog variables (D7).

**Negative / costs**
- **Schema change:** `DocumentTemplate.tenant_id` becomes conditionally nullable. Every template query and guard must be reviewed (§4).
- **Changes to LOCKED directives:** DOC-2 (tenant-only template scope) and DOC-TEMPLATE-ADMIN-RTR-1 (ATS Settings screen, code-defined RTR variables) need superseding amendments.
- **Permissions:** permissions must be consolidated. `document_template:*`, the unused `sign:template:*` and the new Org-level grant need one ruling (O-3). The seeded role-permission count changes.
- **No content link:** tenant templates are independent works, so Aramo has no record of which tenant templates resemble a default. That is intended: a defect in an Aramo default is fixed by publishing a new default version (D3), and tenant-created content is the tenant's responsibility.

## 6. Open items for Lead / PO

- **O-1 Provenance: RESOLVED (PO 2026-10-20).** There is no copy, so there is no provenance (D5).
- **O-2 Legal terms: RESOLVED, YES (PO 2026-10-20).** Legal confirms the terms: Aramo defaults are provided as-is, and a tenant-created template is the tenant's own content and responsibility. Legal also reviews the content of any default that is a legal instrument (lease, loan, NDA). The Legal review itself is still to be done before defaults ship.
- **O-3 Permissions: RESOLVED, no new tenant permission (PO 2026-10-20).**
  - The existing `document_template:read` and `document_template:manage` are already product-neutral in name. They stay, held by the organization-level `tenant_owner` and `tenant_admin` (D11).
  - The unused `sign:template:use` and `sign:template:manage` are removed.
  - **Still needed:** one **platform-tier** permission for the SaaS owner to author defaults and the variable catalog in Platform Admin. Platform and tenant permissions are kept apart by design, so a tenant permission can never authorize a platform action.
  - **Confirm:** Sign senders get `document_template:read` so they can start envelopes from templates.
- **O-4 Withdrawal: RESOLVED (PO 2026-10-20).** The notice period is **7 days by default** and **configurable** by the SaaS owner per withdrawal (D10).
- **O-5 Database guards: MANDATORY MIGRATION PRECONDITION (Lead 2026-10-20).** This is not an open product decision. Recon: do any row-level security (RLS) policies or erasure triggers on the `documents` tables assume `tenant_id NOT NULL`? This must be resolved before the migration.
- **O-6 Organization-level Owner/Admin: RESOLVED by ADR-0035 (ACCEPTED 2026-10-20).** `tenant_owner` and `tenant_admin` are organization roles with administration of the products the tenant holds. The template-admin permission `document_template:{read,manage}` is held by them per D11 and ADR-0035 R1.

## 7. Implementation outline (each increment needs its own LOCKED directive)

1. **Foundation:** owner scope, selection table, variable catalog, read-path union, Platform Admin authoring for defaults, and the migration of existing RTR selections.
2. **Org Home:** gallery, "Create your own document template", approval, and active choices per type and client. ATS flows resolve templates through the selection.
3. **Sign:** "start envelope from template" through the Documents API. This replaces the "Future capability" Templates page.
4. **Then:** withdrawal flow (D10), product filtering (D9), and retiring the ATS Settings section (D11).

## 8. Ratification (Lead Architect, 2026-10-20)

**Disposition:** APPROVED WITH IMPLEMENTATION SAFEGUARDS. D1–D12 are approved. The Documents domain remains the single authority for document templates across ATS, Aramo Sign and personal tenants.

**Binding boundaries**
1. Aramo defaults can't be modified by tenants.
2. Tenant-created templates stay independent, with no copy or inheritance relationship.
3. Generated and signed documents keep their exact template version. Tenants resolve only the current version of a default, and the active template is always an explicit selection.
4. Platform template administration needs separate platform-tier authorization. Platform authoring stays apart from tenant template administration.
5. Sign reads templates through the Documents API, never by direct database access.
6. Withdrawing a template can't silently replace the wording of documents being sent.
7. Defaults that are legal instruments need their own content and legal approval before they are published.
8. The database guard, RLS and erasure-trigger reconciliation (O-5) is a mandatory precondition for the schema migration.
9. The role dependency is reconciled with ADR-0035.

**Increments:** the implementation outline in §7 does not require separate architecture approval for each increment. The implementation may be organized efficiently, provided the migration and authorization safeguards are respected. Production migrations, deployment and authorization expansion stay subject to an implementation Gate-5 review.
