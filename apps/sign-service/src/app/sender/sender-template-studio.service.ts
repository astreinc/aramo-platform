import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { IdentityRepository } from '@aramo/identity';

import {
  DOCUMENT_TEMPLATE_STUDIO_PORT,
  type DocumentTemplateStudioPort,
  type StudioMethod,
} from '../document-template-studio-http.adapter.js';

import { personalWorkspaceLabel, SenderContextService } from './sender-context.service.js';
import { SenderTemplatesService } from './sender-templates.service.js';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.2–8.3 (R6) and §8.5 (R6-M).
//
//   - The template gallery (Aramo defaults tagged `sign`, with whether the tenant already has a
//     copy) and its preview — every tenant kind (the mobile "Use as it is" list).
//   - "Use as it is": POST library/:id/adopt-and-use — adopt + approve the unchanged copy, which
//     becomes the tenant's current version for its type (ADR-0034 D6).
//   - The Studio of a PERSONAL account (§8.3): its own templates, adopt / edit / preview /
//     "Use this version". A BUSINESS tenant is refused 403 here: Org Home owns organization
//     templates (A2 principle kept; §10 amendment row).
//
// Sign stores nothing (A2 principle): every call goes to apps/api over the signed
// service-to-service channel (DocumentTemplateStudioHttpAdapter); Documents owns every row and
// re-checks the person's live template grants. Every route first passes the SAME gate as the
// template "use" routes (SenderTemplatesService.assertMayUse): sign.templates launch
// availability, document_template:read, then the plan (Catalog v2 P-6: never the Free plan).
//
// Letterhead (§8.2): a Personal account's letterhead is the person's name — the Personal
// workspace label (personalWorkspaceLabel), never the stored tenant handle.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(requestId: string, field: string): AramoError {
  return new AramoError('VALIDATION_ERROR', `${field} must be a uuid`, 400, { requestId, details: { field } });
}

function uuid(v: unknown, field: string, requestId: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad(requestId, field);
  return v;
}

function obj(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

@Injectable()
export class SenderTemplateStudioService {
  constructor(
    @Inject(DOCUMENT_TEMPLATE_STUDIO_PORT) private readonly documents: DocumentTemplateStudioPort,
    private readonly templates: SenderTemplatesService,
    private readonly context: SenderContextService,
    private readonly identity: IdentityRepository,
  ) {}

  private async personalLabel(auth: AuthContextType): Promise<string> {
    return personalWorkspaceLabel((await this.identity.findUserById(auth.sub))?.display_name);
  }

  // ── gallery + "Use as it is" (every tenant kind) ────────────────────────────────────

  async gallery(auth: AuthContextType, requestId: string) {
    await this.templates.assertMayUse(auth, requestId);
    return this.documents.call({ method: 'GET', path: '/library', query: { tenant_id: auth.tenant_id }, requestId });
  }

  async galleryPreview(auth: AuthContextType, id: string, requestId: string) {
    await this.templates.assertMayUse(auth, requestId);
    const template_id = uuid(id, 'id', requestId);
    const preview = await this.documents.call<{ letterhead?: { organization_name: string | null; logo_available: boolean } }>({
      method: 'GET',
      path: `/library/${encodeURIComponent(template_id)}/preview`,
      query: { tenant_id: auth.tenant_id },
      requestId,
    });
    if ((await this.context.tenantKind(auth.tenant_id, requestId)) !== 'PERSONAL' || preview?.letterhead === undefined) return preview;
    return { ...preview, letterhead: { ...preview.letterhead, organization_name: await this.personalLabel(auth) } };
  }

  async adoptAndUse(auth: AuthContextType, id: string, requestId: string) {
    await this.templates.assertMayUse(auth, requestId);
    const template_id = uuid(id, 'id', requestId);
    return this.documents.call({
      method: 'POST',
      path: `/library/${encodeURIComponent(template_id)}/adopt-and-use`,
      query: { tenant_id: auth.tenant_id, actor_id: auth.sub },
      body: {},
      requestId,
    });
  }

  // ── the Personal Studio ─────────────────────────────────────────────────────────────

  private async studio<T>(auth: AuthContextType, method: StudioMethod, path: string, requestId: string, body?: unknown): Promise<T> {
    await this.templates.assertMayUse(auth, requestId);
    if ((await this.context.tenantKind(auth.tenant_id, requestId)) !== 'PERSONAL') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'An organization adopts and edits its templates in Org Home', 403, {
        requestId,
        details: { reason: 'organization_templates_in_org_home' },
      });
    }
    return this.documents.call<T>({
      method,
      path: `/studio${path}`,
      query: { tenant_id: auth.tenant_id, actor_id: auth.sub },
      ...(body !== undefined ? { body } : {}),
      requestId,
    });
  }

  async list(auth: AuthContextType, requestId: string) {
    return this.studio(auth, 'GET', '', requestId);
  }

  async adopt(auth: AuthContextType, body: unknown, requestId: string) {
    const library_template_id = uuid(obj(body)['library_template_id'], 'library_template_id', requestId);
    return this.studio(auth, 'POST', '/adopt', requestId, { library_template_id });
  }

  async get(auth: AuthContextType, id: string, requestId: string) {
    return this.studio(auth, 'GET', `/${uuid(id, 'id', requestId)}`, requestId);
  }

  async rename(auth: AuthContextType, id: string, body: unknown, requestId: string) {
    return this.studio(auth, 'PATCH', `/${uuid(id, 'id', requestId)}`, requestId, { name: obj(body)['name'] });
  }

  async versions(auth: AuthContextType, id: string, requestId: string) {
    return this.studio(auth, 'GET', `/${uuid(id, 'id', requestId)}/versions`, requestId);
  }

  async createVersion(auth: AuthContextType, id: string, body: unknown, requestId: string) {
    const b = obj(body);
    return this.studio(auth, 'POST', `/${uuid(id, 'id', requestId)}/versions`, requestId, {
      render_schema_version: b['render_schema_version'],
      field_schema: b['field_schema'],
    });
  }

  async createDraft(auth: AuthContextType, id: string, requestId: string) {
    return this.studio(auth, 'POST', `/${uuid(id, 'id', requestId)}/draft`, requestId, {});
  }

  async allowedBindings(auth: AuthContextType, id: string, requestId: string) {
    const out = await this.studio<{ bindings: unknown[]; tenant_logo?: { available: boolean; tenant_name: string | null } }>(
      auth,
      'GET',
      `/${uuid(id, 'id', requestId)}/allowed-bindings`,
      requestId,
    );
    // §8.2 — the letterhead is the person's name (the Studio is PERSONAL-only); a Personal
    // account has no organization logo to capture, so none is offered.
    return { ...out, tenant_logo: { available: false, tenant_name: await this.personalLabel(auth) } };
  }

  async updateVersion(auth: AuthContextType, versionId: string, body: unknown, requestId: string) {
    const b = obj(body);
    const patch: Record<string, unknown> = {};
    for (const k of ['field_schema', 'render_schema_version', 'internal_notes']) if (k in b) patch[k] = b[k];
    return this.studio(auth, 'PATCH', `/versions/${uuid(versionId, 'versionId', requestId)}`, requestId, patch);
  }

  async discardDraft(auth: AuthContextType, versionId: string, requestId: string): Promise<void> {
    await this.studio(auth, 'DELETE', `/versions/${uuid(versionId, 'versionId', requestId)}`, requestId);
  }

  async preview(auth: AuthContextType, versionId: string, requestId: string) {
    return this.studio(auth, 'POST', `/versions/${uuid(versionId, 'versionId', requestId)}/preview`, requestId, {});
  }

  async activate(auth: AuthContextType, versionId: string, requestId: string) {
    return this.studio(auth, 'POST', `/versions/${uuid(versionId, 'versionId', requestId)}/activate`, requestId, {});
  }
}
