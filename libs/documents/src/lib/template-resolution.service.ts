import { Injectable } from '@nestjs/common';

import { TemplatesRepository } from './templates.repository.js';

// DOC-TEMPLATE-LIB-1 T-3 (§4.2; ADR-0034 D3/D6/D10) — the generic, workflow-neutral
// template resolver. Generalised from the RTR resolver (apps/api rtr-template-resolver):
//
//   1. the tenant's selection for (type, client)      — when a client is known
//   2. the tenant's selection for (type, tenant-wide)
//   3. the Aramo (PLATFORM) default for the type: ACTIVE and not past
//      withdraw_effective_at
//
// The result PINS the exact current TemplateVersion (current_version_id is the
// authority — never "latest" or "first ACTIVE row"). Every broken configuration is
// reported, never repaired: the caller maps the typed outcome to its own fail-closed
// refusal (RTR: RTR_TEMPLATE_NOT_CONFIGURED / _CONFIGURATION_INVALID /
// TEMPLATE_SELECTION_REQUIRED). Pure reads; no rendering, no business-data access.
//
// DOC-TEMPLATE-LIB-1 T-6 (§9; ADR-0034 D10) — WITHDRAWAL. An Aramo default whose
// withdrawal has taken effect (withdraw_effective_at <= now) is never resolved:
//   * a selection naming it is skipped (a client selection then still consults the
//     tenant-wide selection — an explicit tenant choice, never a silent swap)
//   * when the tenant was relying on it (a skipped selection, or no selection while the
//     only default of the type is withdrawn), resolution falls to the tenant's own most
//     recently approved ACTIVE template for the type (that client's first, then
//     tenant-wide) — source WITHDRAWAL_FALLBACK — else SELECTION_REQUIRED. It never
//     falls to ANOTHER Aramo default: that would swap the wording silently.
//   * with no selection, a live replacement default is resolved; during a notice window
//     the default with no withdrawal is preferred over the one being withdrawn.
// Already generated documents keep their pinned version (nothing here touches a pin).
//
// ORG-UX-1 (Directive v1.0 LOCKED §5.3; conforming amendments rows 4/6) — GALLERY-FIRST.
// Aramo defaults are starting points, never used directly: step 3 ("no selection → the
// Aramo default") is REMOVED. A selection naming a PLATFORM template is honoured ONLY when
// it is a grandfathered legacy selection (legacy_platform = true, written once by the T-A
// migration 20261022130000 for tenants that relied on the default); any other PLATFORM
// selection is ignored. With no usable selection the outcome is SELECTION_REQUIRED (adopt
// or create, then approve) when the type has an Aramo starting point, else NOT_CONFIGURED.

//
// TEMPLATE-PRODUCT-1 (Directive v1.0 LOCKED §6.3) — PRODUCT TAGS ENFORCED. With `product` set,
// only templates tagged with it take part: a selection naming an untagged template is skipped
// (like any unusable choice), the withdrawal fallback and the "has an Aramo starting point"
// decision consider only tagged templates. ATS (RTR) resolves with `ats`, Aramo Sign with
// `sign`, so the Sign is_default auto-choice is the same rule over sign-tagged templates.
// Without `product` nothing is filtered (unchanged for any other caller).

export type TemplateResolutionSource = 'CLIENT_SELECTION' | 'TENANT_SELECTION' | 'PLATFORM_DEFAULT' | 'WITHDRAWAL_FALLBACK';

type TemplateRow = NonNullable<Awaited<ReturnType<TemplatesRepository['findTemplateByIdOwnerAware']>>>;
type VersionRow = NonNullable<Awaited<ReturnType<TemplatesRepository['findVersionByIdOwnerAware']>>>;

export type TemplateResolution =
  | {
      outcome: 'RESOLVED';
      source: TemplateResolutionSource;
      owner_scope: 'PLATFORM' | 'TENANT';
      template: TemplateRow;
      version: VersionRow;
    }
  | { outcome: 'NOT_CONFIGURED' }
  // T-6 — the Aramo default the tenant relied on is withdrawn and it has no approved
  // template of its own for the type: the tenant admin/owner must choose (409).
  | { outcome: 'SELECTION_REQUIRED'; withdrawn_template_ids: string[] }
  | { outcome: 'INVALID'; template_id: string | null; reason: string; details?: Record<string, unknown> };

export interface ResolveTemplateInput {
  tenant_id: string;
  document_type_id: string;
  // The client the document is for, when the flow knows one. null/absent/'' ⇒ only the
  // tenant-wide selection and the Aramo default are consulted.
  client_id?: string | null;
  // TEMPLATE-PRODUCT-1 §6.3 — the product the document is for (`ats` / `sign`): only
  // templates tagged with it resolve. Absent ⇒ no product filter.
  product?: string;
}

// A template carries the product (case-insensitive; the stored keys are lowercase since TP-1).
// A row with NO recorded tags (null — not possible after migration 20261103120000, whose CHECK,
// backfill and insert trigger give every row an array) is treated as unrestricted, so a legacy
// row is never silently dropped; an EMPTY array is tagged with nothing.
function tagged(products: readonly string[] | null | undefined, product: string | undefined): boolean {
  if (product === undefined || products === null || products === undefined) return true;
  const want = product.toLowerCase();
  return products.some((p) => p.toLowerCase() === want);
}

@Injectable()
export class TemplateResolutionService {
  constructor(
    private readonly templates: TemplatesRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve(input: ResolveTemplateInput): Promise<TemplateResolution> {
    const at = this.now();
    const client = input.client_id !== undefined && input.client_id !== null && input.client_id.length > 0 ? input.client_id : null;

    const steps: Array<{ client_id: string | null; source: TemplateResolutionSource }> = [];
    if (client !== null) steps.push({ client_id: client, source: 'CLIENT_SELECTION' });
    steps.push({ client_id: null, source: 'TENANT_SELECTION' });

    const withdrawn: string[] = [];
    for (const step of steps) {
      const sel = await this.templates.findSelection(input.tenant_id, input.document_type_id, step.client_id);
      if (sel === null) continue;
      const template = await this.templates.findTemplateByIdOwnerAware(input.tenant_id, sel.template_id);
      if (template === null || template.document_type_id !== input.document_type_id) {
        return { outcome: 'INVALID', template_id: sel.template_id, reason: 'selected_template_missing' };
      }
      // ORG-UX-1 §5.3 — only a grandfathered selection may name an Aramo default.
      if (template.owner_scope === 'PLATFORM' && sel.legacy_platform !== true) continue;
      // TEMPLATE-PRODUCT-1 §6.3 — a template not tagged with the product is not offered to it.
      if (!tagged(template.products, input.product)) continue;
      // A withdrawn Aramo default (past effective) is never resolved — move on, and
      // remember the tenant relied on it (D10 fallback below).
      if (template.owner_scope === 'PLATFORM' && isWithdrawn(template.withdraw_effective_at, at)) {
        withdrawn.push(template.id);
        continue;
      }
      if (template.status !== 'ACTIVE') {
        return { outcome: 'INVALID', template_id: template.id, reason: 'selected_template_not_active', details: { status: template.status } };
      }
      return this.pin(input.tenant_id, template, step.source);
    }
    if (withdrawn.length > 0) return this.withdrawalFallback(input.tenant_id, input.document_type_id, client, withdrawn, input.product);

    // ORG-UX-1 §5.3 — no usable selection: the Aramo default is NOT resolved. When the
    // type has an Aramo starting point (live, or withdrawn) the tenant must adopt or create
    // and approve its own template (SELECTION_REQUIRED); otherwise nothing is configured.
    const defaults = (await this.templates.findResolvablePlatformDefaults(input.document_type_id, at)).filter((d) =>
      tagged(d.products, input.product),
    );
    if (defaults.length > 0) return { outcome: 'SELECTION_REQUIRED', withdrawn_template_ids: [] };
    const gone = await this.templates.listWithdrawnPlatformDefaultIds(input.document_type_id, at, input.product);
    // T-6 unchanged: a withdrawn default the type relied on → the tenant's own approved template.
    if (gone.length > 0) return this.withdrawalFallback(input.tenant_id, input.document_type_id, client, gone, input.product);
    return { outcome: 'NOT_CONFIGURED' };
  }

  // D10 — the tenant's own approved template for the type (client first, then
  // tenant-wide; most recently approved first). The first one that pins cleanly wins;
  // none ⇒ SELECTION_REQUIRED (the flow asks the tenant admin/owner to choose).
  private async withdrawalFallback(
    tenant_id: string,
    document_type_id: string,
    client_id: string | null,
    withdrawn_template_ids: string[],
    product?: string,
  ): Promise<TemplateResolution> {
    const own = await this.templates.listTenantFallbackTemplates(tenant_id, document_type_id, client_id, product);
    for (const t of own) {
      const r = await this.pin(tenant_id, t as TemplateRow, 'WITHDRAWAL_FALLBACK');
      if (r.outcome === 'RESOLVED') return r;
    }
    return { outcome: 'SELECTION_REQUIRED', withdrawn_template_ids };
  }

  // current_version_id is authoritative: absent / missing / foreign / not ACTIVE ⇒ INVALID.
  private async pin(tenant_id: string, template: TemplateRow, source: TemplateResolutionSource): Promise<TemplateResolution> {
    if (template.current_version_id === null) {
      return { outcome: 'INVALID', template_id: template.id, reason: 'current_version_id_null' };
    }
    const version = await this.templates.findVersionByIdOwnerAware(tenant_id, template.current_version_id);
    if (version === null) return { outcome: 'INVALID', template_id: template.id, reason: 'current_version_missing' };
    if (version.template_id !== template.id) {
      return { outcome: 'INVALID', template_id: template.id, reason: 'current_version_foreign' };
    }
    if (version.status !== 'ACTIVE') {
      return { outcome: 'INVALID', template_id: template.id, reason: 'current_version_not_active', details: { status: version.status } };
    }
    return {
      outcome: 'RESOLVED',
      source,
      owner_scope: template.owner_scope === 'PLATFORM' ? 'PLATFORM' : 'TENANT',
      template,
      version,
    };
  }
}

function isWithdrawn(effective_at: Date | null, at: Date): boolean {
  return effective_at !== null && effective_at.getTime() <= at.getTime();
}
