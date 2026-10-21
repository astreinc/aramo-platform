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
// authority — never "latest" or "first ACTIVE row"). A selection naming an Aramo
// default whose withdrawal has taken effect is skipped and resolution continues down
// the order (T-6 adds the tenant-template fallback + TEMPLATE_SELECTION_REQUIRED). Every
// broken configuration is reported, never repaired: the caller maps the typed outcome
// to its own fail-closed refusal (RTR: RTR_TEMPLATE_NOT_CONFIGURED / _CONFIGURATION_INVALID).
// Pure reads; no rendering, no business-data access.

export type TemplateResolutionSource = 'CLIENT_SELECTION' | 'TENANT_SELECTION' | 'PLATFORM_DEFAULT';

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
  | { outcome: 'INVALID'; template_id: string | null; reason: string; details?: Record<string, unknown> };

export interface ResolveTemplateInput {
  tenant_id: string;
  document_type_id: string;
  // The client the document is for, when the flow knows one. null/absent/'' ⇒ only the
  // tenant-wide selection and the Aramo default are consulted.
  client_id?: string | null;
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

    for (const step of steps) {
      const sel = await this.templates.findSelection(input.tenant_id, input.document_type_id, step.client_id);
      if (sel === null) continue;
      const template = await this.templates.findTemplateByIdOwnerAware(input.tenant_id, sel.template_id);
      if (template === null || template.document_type_id !== input.document_type_id) {
        return { outcome: 'INVALID', template_id: sel.template_id, reason: 'selected_template_missing' };
      }
      // A withdrawn Aramo default (past effective) is never resolved — move on.
      if (template.owner_scope === 'PLATFORM' && isWithdrawn(template.withdraw_effective_at, at)) continue;
      if (template.status !== 'ACTIVE') {
        return { outcome: 'INVALID', template_id: template.id, reason: 'selected_template_not_active', details: { status: template.status } };
      }
      return this.pin(input.tenant_id, template, step.source);
    }

    const defaults = await this.templates.findResolvablePlatformDefaults(input.document_type_id, at);
    if (defaults.length === 0) return { outcome: 'NOT_CONFIGURED' };
    if (defaults.length > 1) {
      // More than one live Aramo default for one type and no tenant choice: never pick one.
      return {
        outcome: 'INVALID',
        template_id: null,
        reason: 'platform_default_ambiguous',
        details: { template_ids: defaults.map((d) => d.id) },
      };
    }
    return this.pin(input.tenant_id, defaults[0] as TemplateRow, 'PLATFORM_DEFAULT');
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
