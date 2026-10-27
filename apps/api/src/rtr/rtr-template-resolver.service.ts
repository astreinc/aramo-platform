import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { TemplateResolutionService, TemplatesRepository, type TemplateResolutionSource } from '@aramo/documents';

import { RIGHT_TO_REPRESENT_TYPE_ID } from './rtr-constants.js';
import {
  RTR_GENERATED_SCHEMA_V1,
  type RtrContentBlock,
  type RtrTemplateContentV1,
} from './rtr-template-content.js';
import { RTR_HTML_SCHEMA_V1, parseHtmlContent, sanitizeRtrHtml, type RtrTemplateContent } from './rtr-html-content.js';

// RTR-TEMPLATE-1 (§6, §10, §27) — the server-authoritative RTR template resolver.
//
// Resolves the tenant's RIGHT_TO_REPRESENT template through explicit selection
// (DOC-TEMPLATE-LIB-1 T-3: client → tenant → Aramo default) and PINS the exact
// current TemplateVersion. Selection is backend-authoritative (INV-1): the
// FE never names a template/version. current_version_id is the authority (§27) —
// never "first ACTIVE row" or "latest created." Every precondition fails CLOSED
// with a typed configuration refusal; there is NO inline-content fallback (INV-12).
//
// The resolved content (version.field_schema parsed as the rtr-generated-v1
// contract) + the pinned version id flow to the binding service (RTR-T2), which
// substitutes the closed binding catalog and renders. This resolver performs NO
// ATS-data access and NO rendering — it is pure template/version resolution.

export interface ResolvedRtrTemplate {
  template_id: string;
  template_version_id: string;
  template_name: string;
  version_number: number;
  render_schema_version: string;
  // A1 §2.1 — exactly rtr-generated-v1 or rtr-html-v1.
  content: RtrTemplateContent;
  // DOC-TEMPLATE-LIB-1 T-3 — who owns the resolved template. A PLATFORM (Aramo default)
  // version carries no tenant asset; the orchestrator binds the tenant's branding at
  // render (§4.3). `source` records which step of the resolution order matched.
  owner_scope: 'PLATFORM' | 'TENANT';
  source: TemplateResolutionSource;
}

@Injectable()
export class RtrTemplateResolverService {
  private readonly resolution: TemplateResolutionService;

  constructor(templates: TemplatesRepository, resolution?: TemplateResolutionService) {
    this.resolution = resolution ?? new TemplateResolutionService(templates);
  }

  // DOC-TEMPLATE-LIB-1 T-3 (§4.2) — delegates to the generic TemplateResolutionService:
  // selection (tenant, RTR, client) → selection (tenant, RTR, tenant-wide) → the Aramo
  // RTR default (ACTIVE, not past withdraw_effective_at). The fail-closed RTR codes are
  // unchanged: nothing resolvable ⇒ RTR_TEMPLATE_NOT_CONFIGURED; a broken selection /
  // template / version ⇒ RTR_TEMPLATE_CONFIGURATION_INVALID.
  async resolveActive(input: { tenant_id: string; client_id?: string | null; requestId: string }): Promise<ResolvedRtrTemplate> {
    const r = await this.resolution.resolve({
      tenant_id: input.tenant_id,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      client_id: input.client_id ?? null,
    });
    if (r.outcome === 'NOT_CONFIGURED') {
      throw new AramoError(
        'RTR_TEMPLATE_NOT_CONFIGURED',
        'No active Right to Represent template is configured for this tenant',
        409,
        {
          requestId: input.requestId,
          details: { tenant_id: input.tenant_id, document_type_id: RIGHT_TO_REPRESENT_TYPE_ID },
        },
      );
    }
    // DOC-TEMPLATE-LIB-1 T-6 (§9; ADR-0034 D10) — the Aramo RTR default this tenant relied
    // on has been withdrawn (effective date passed) and the tenant has no approved RTR
    // template of its own: the tenant admin/owner must choose. Distinct from
    // RTR_TEMPLATE_NOT_CONFIGURED (never configured) — the wording is never swapped silently.
    // ORG-UX-1 (LOCKED §5.3) — gallery-first: SELECTION_REQUIRED also means "no approved
    // RTR template yet" (withdrawn_template_ids empty) — adopt or create one, then approve.
    if (r.outcome === 'SELECTION_REQUIRED') {
      throw new AramoError(
        'TEMPLATE_SELECTION_REQUIRED',
        r.withdrawn_template_ids.length > 0
          ? 'The Aramo Right to Represent default was withdrawn; choose a template for this organization'
          : 'This organization has no approved Right to Represent template; adopt or create one and approve it',
        409,
        {
          requestId: input.requestId,
          details: {
            document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
            withdrawn_template_ids: r.withdrawn_template_ids,
          },
        },
      );
    }
    if (r.outcome === 'INVALID') {
      throw this.invalid(input.requestId, r.template_id, r.reason, r.details);
    }
    return this.pinned({ template: r.template, version: r.version, owner_scope: r.owner_scope, source: r.source, requestId: input.requestId });
  }

  // Amendment M-A6 §3.1 — the same content-contract parse for a template the caller has
  // already pinned (Sign lists and uses every ACTIVE template the tenant may use; the
  // automatic per-type resolution above is unchanged). Fails closed exactly like
  // resolveActive (RTR_TEMPLATE_CONFIGURATION_INVALID).
  pinned(input: {
    template: { id: string; name: string };
    version: { id: string; version_number: number; render_schema_version: string; field_schema: unknown };
    owner_scope: 'PLATFORM' | 'TENANT';
    source: TemplateResolutionSource;
    requestId: string;
  }): ResolvedRtrTemplate {
    const { template, version } = input;

    // Unrecognised content-contract version ⇒ fail closed (§8): never interpret.
    if (version.render_schema_version !== RTR_GENERATED_SCHEMA_V1 && version.render_schema_version !== RTR_HTML_SCHEMA_V1) {
      throw this.invalid(input.requestId, template.id, 'unrecognised_render_schema_version', {
        render_schema_version: version.render_schema_version,
      });
    }

    const content: RtrTemplateContent | null =
      version.render_schema_version === RTR_HTML_SCHEMA_V1
        ? this.parseHtml(version.field_schema)
        : this.parseContent(version.field_schema);
    if (content === null) {
      throw this.invalid(input.requestId, template.id, 'content_schema_invalid');
    }

    return {
      template_id: template.id,
      template_version_id: version.id,
      template_name: template.name,
      version_number: version.version_number,
      render_schema_version: version.render_schema_version,
      content,
      owner_scope: input.owner_scope,
      source: input.source,
    };
  }

  private invalid(
    requestId: string,
    template_id: string | null,
    reason: string,
    extra?: Record<string, unknown>,
  ): AramoError {
    return new AramoError(
      'RTR_TEMPLATE_CONFIGURATION_INVALID',
      'The active Right to Represent template is not usable (configuration invalid)',
      422,
      { requestId, details: { template_id, reason, ...(extra ?? {}) } },
    );
  }

  // A1 — rtr-html-v1: structurally valid AND still clean under the allowlist (the stored
  // html was sanitised at PATCH; a non-canonical / unknown-field html fails closed).
  private parseHtml(fieldSchema: unknown): RtrTemplateContent | null {
    const c = parseHtmlContent(fieldSchema);
    if (c === null || c.title.trim().length === 0) return null;
    const res = sanitizeRtrHtml(c.html);
    if ('issue' in res) return null;
    return { ...c, html: res.html };
  }

  // Structural validation of the stored field_schema against the rtr-generated-v1
  // contract. Closed shape only (INV-9): title + ordered HEADING/TEXT blocks with
  // string text. Returns null on any structural mismatch (caller fails closed).
  private parseContent(fieldSchema: unknown): RtrTemplateContentV1 | null {
    if (typeof fieldSchema !== 'object' || fieldSchema === null) return null;
    const obj = fieldSchema as Record<string, unknown>;
    if (obj.render_schema_version !== RTR_GENERATED_SCHEMA_V1) return null;
    if (typeof obj.title !== 'string' || obj.title.length === 0) return null;
    if (!Array.isArray(obj.blocks) || obj.blocks.length === 0) return null;
    const blocks: RtrContentBlock[] = [];
    for (const raw of obj.blocks) {
      if (typeof raw !== 'object' || raw === null) return null;
      const b = raw as Record<string, unknown>;
      if (b.type !== 'HEADING' && b.type !== 'TEXT') return null;
      if (typeof b.text !== 'string') return null;
      blocks.push({ type: b.type, text: b.text });
    }
    return { render_schema_version: RTR_GENERATED_SCHEMA_V1, title: obj.title, blocks };
  }
}
