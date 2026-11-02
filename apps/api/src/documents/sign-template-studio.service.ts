import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { DocumentTemplateLibraryController, DocumentTemplatesController, TemplateLibraryItem, TemplatesRepository } from '@aramo/documents';
import type { RoleService, TenantRepository } from '@aramo/identity';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.3 / §8.5 (R6, R6-M) — the
// Documents side of the Aramo Sign template Studio and of "Use as it is", called ONLY by
// sign-service over the existing signed service-to-service channel (aramo-sign-s2s-v1).
//
// Sign stores nothing: every row is a Documents row, written by the SAME tenant template code
// the Org Home Studio uses — this service drives the existing DocumentTemplatesController /
// DocumentTemplateLibraryController methods (constructed with the same repository, capability,
// audit, logo and branding ports) with the acting person's auth context, never a copy of their
// logic (adopt transform, preview gate, closed catalog, approval → selection, governance audit).
//
// The S2S request carries no session, so the authority is resolved HERE from the person's live
// role grants in the tenant (RoleService — the canonical scope set of their active roles, the
// same set the Org session is filtered from). It never widens a token:
//   - the Studio (PERSONAL tenants only; a BUSINESS tenant manages templates in Org Home, 403):
//     reads need document_template:author or :manage, edits :author, "Use this version" :manage
//     (the Personal owner — tenant_owner — holds both);
//   - "Use as it is" (any tenant kind): document_template:manage (a Personal owner; a Business
//     tenant_owner / tenant_admin). Everyone else is refused 403 reason template_approval_required.
// Only Aramo defaults tagged `sign` are offered or adoptable here (§6.3: the Sign surface).

export const TEMPLATE_AUTHOR_SCOPE = 'document_template:author';
export const TEMPLATE_MANAGE_SCOPE = 'document_template:manage';
const SIGN_PRODUCT = 'sign';

/** Why a Sign template request was refused (details.reason of the 403). */
export const STUDIO_REFUSALS = {
  organization: 'organization_templates_in_org_home',
  author: 'template_authoring_required',
  approve: 'template_approval_required',
  tenant: 'tenant_unknown',
} as const;

export type StudioNeed = 'read' | 'author' | 'manage';

export interface SignTemplateStudioDeps {
  templates: TemplatesRepository;
  tenantTemplates: DocumentTemplatesController;
  library: DocumentTemplateLibraryController;
  tenants: TenantRepository;
  roles: RoleService;
}

/** One Aramo default tagged `sign`, as the Sign gallery lists it. */
export interface SignTemplateGalleryItem {
  readonly template_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly document_type: { readonly id: string; readonly name: string | null };
  readonly products: readonly string[];
  readonly version_id: string;
  readonly version_number: number | null;
  readonly updated_at: string;
  /** The tenant's own copy of this default (the newest one), or null when not adopted. */
  readonly adopted_template_id: string | null;
}

function refused(reason: string, message: string, requestId: string): AramoError {
  return new AramoError('INSUFFICIENT_PERMISSIONS', message, 403, { requestId, details: { reason } });
}

function notFound(id: string, requestId: string): AramoError {
  return new AramoError('TEMPLATE_NOT_FOUND', `template ${id} is not an Aramo template for Aramo Sign`, 404, { requestId });
}

const isSignDefault = (i: TemplateLibraryItem): boolean =>
  i.owner_scope === 'PLATFORM' && i.configurable && i.current_version_id !== null && (i.products ?? []).includes(SIGN_PRODUCT);

export class SignTemplateStudioService {
  constructor(private readonly d: SignTemplateStudioDeps) {}

  // The acting person as an auth context the tenant template code accepts, after the
  // tenant-kind and live-role checks. scopes = the template scopes they actually hold.
  async principal(input: { tenant_id: string; actor_id: string; need: StudioNeed; personalOnly: boolean; requestId: string }): Promise<AuthContextType> {
    const { requestId } = input;
    const tenant = await this.d.tenants.findById(input.tenant_id);
    if (tenant === null) throw refused(STUDIO_REFUSALS.tenant, 'Tenant not found', requestId);
    if (input.personalOnly && tenant.kind !== 'PERSONAL') {
      throw refused(STUDIO_REFUSALS.organization, 'An organization adopts and edits its templates in Org Home', requestId);
    }
    const held = new Set(await this.d.roles.getScopesByUserAndTenant({ user_id: input.actor_id, tenant_id: input.tenant_id }));
    const author = held.has(TEMPLATE_AUTHOR_SCOPE);
    const manage = held.has(TEMPLATE_MANAGE_SCOPE);
    if (input.need === 'manage' && !manage) throw refused(STUDIO_REFUSALS.approve, 'Only an admin can approve a template', requestId);
    if (input.need === 'author' && !author) throw refused(STUDIO_REFUSALS.author, 'You cannot edit templates', requestId);
    if (input.need === 'read' && !author && !manage) throw refused(STUDIO_REFUSALS.author, 'You cannot open the template Studio', requestId);
    return {
      sub: input.actor_id,
      tenant_id: input.tenant_id,
      consumer_type: 'sign',
      actor_kind: 'user',
      scopes: ['document_template:read', ...(author ? [TEMPLATE_AUTHOR_SCOPE] : []), ...(manage ? [TEMPLATE_MANAGE_SCOPE] : [])],
      iat: 0,
      exp: 0,
    };
  }

  // A read-only auth context for the gallery reads (sign-service checked document_template:read).
  private reader(tenant_id: string): AuthContextType {
    return { sub: tenant_id, tenant_id, consumer_type: 'sign', actor_kind: 'user', scopes: ['document_template:read'], iat: 0, exp: 0 };
  }

  // ── gallery (§8.5 — every tenant kind) ───────────────────────────────────────────────

  async gallery(input: { tenant_id: string; requestId: string }): Promise<{ items: SignTemplateGalleryItem[] }> {
    const tenant = await this.d.tenants.findById(input.tenant_id);
    if (tenant === null) throw refused(STUDIO_REFUSALS.tenant, 'Tenant not found', input.requestId);
    const view = await this.d.library.library(this.reader(input.tenant_id));
    const typeNames = new Map(view.document_types.map((t) => [t.id, t.name]));
    const adopted = await this.adoptedCopies(input.tenant_id);
    const items = view.items.filter(isSignDefault).map(
      (i): SignTemplateGalleryItem => ({
        template_id: i.id,
        name: i.name,
        description: i.description,
        document_type: { id: i.document_type_id, name: typeNames.get(i.document_type_id) ?? null },
        products: [...(i.products ?? [])],
        version_id: i.current_version_id as string,
        version_number: i.current_version_number,
        updated_at: i.updated_at,
        adopted_template_id: adopted.get(i.id) ?? null,
      }),
    );
    return { items };
  }

  // The tenant's newest copy of each adopted default (provenance read, never a link).
  private async adoptedCopies(tenant_id: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const t of await this.d.templates.listTemplates(tenant_id)) {
      if (t.adopted_from_template_id !== null && !out.has(t.adopted_from_template_id)) out.set(t.adopted_from_template_id, t.id);
    }
    return out;
  }

  private async assertSignDefault(tenant_id: string, id: string, requestId: string): Promise<SignTemplateGalleryItem> {
    const item = (await this.gallery({ tenant_id, requestId })).items.find((i) => i.template_id === id);
    if (item === undefined) throw notFound(id, requestId);
    return item;
  }

  async galleryPreview(input: { tenant_id: string; template_id: string; requestId: string }) {
    await this.assertSignDefault(input.tenant_id, input.template_id, input.requestId);
    return this.d.library.previewDefault(this.reader(input.tenant_id), input.template_id, input.requestId);
  }

  // ── Studio (§8.2–8.3 — PERSONAL tenants only) ────────────────────────────────────────

  private studio(input: { tenant_id: string; actor_id: string; requestId: string }, need: StudioNeed): Promise<AuthContextType> {
    return this.principal({ ...input, need, personalOnly: true });
  }

  /** The Studio list: the person's own templates + the Aramo defaults tagged `sign`. */
  async studioList(input: { tenant_id: string; actor_id: string; requestId: string }) {
    const auth = await this.studio(input, 'read');
    const view = await this.d.library.library(auth);
    const adopted = await this.adoptedCopies(input.tenant_id);
    return {
      items: view.items
        .filter((i) => i.owner_scope === 'TENANT' || isSignDefault(i))
        .map((i) => ({ ...i, adopted_template_id: i.owner_scope === 'PLATFORM' ? (adopted.get(i.id) ?? null) : null })),
      document_types: view.document_types,
    };
  }

  async adopt(input: { tenant_id: string; actor_id: string; library_template_id: string; requestId: string }) {
    const auth = await this.studio(input, 'author');
    await this.assertSignDefault(input.tenant_id, input.library_template_id, input.requestId);
    return this.d.tenantTemplates.adopt(auth, { library_template_id: input.library_template_id }, input.requestId);
  }

  async get(input: { tenant_id: string; actor_id: string; template_id: string; requestId: string }) {
    return this.d.tenantTemplates.get(await this.studio(input, 'read'), input.template_id, input.requestId);
  }

  async rename(input: { tenant_id: string; actor_id: string; template_id: string; name: unknown; requestId: string }) {
    return this.d.tenantTemplates.rename(await this.studio(input, 'author'), input.template_id, { name: input.name as string }, input.requestId);
  }

  async listVersions(input: { tenant_id: string; actor_id: string; template_id: string; requestId: string }) {
    return this.d.tenantTemplates.listVersions(await this.studio(input, 'read'), input.template_id, input.requestId);
  }

  async createVersion(input: { tenant_id: string; actor_id: string; template_id: string; body: { render_schema_version?: unknown; field_schema?: unknown }; requestId: string }) {
    const auth = await this.studio(input, 'author');
    return this.d.tenantTemplates.createVersion(
      auth,
      input.template_id,
      { render_schema_version: input.body.render_schema_version as string, field_schema: input.body.field_schema },
      input.requestId,
    );
  }

  async createDraft(input: { tenant_id: string; actor_id: string; template_id: string; requestId: string }) {
    return this.d.tenantTemplates.createDraft(await this.studio(input, 'author'), input.template_id, input.requestId);
  }

  async allowedBindings(input: { tenant_id: string; actor_id: string; template_id: string; requestId: string }) {
    return this.d.tenantTemplates.allowedBindings(await this.studio(input, 'read'), input.template_id, input.requestId);
  }

  async updateVersion(input: {
    tenant_id: string;
    actor_id: string;
    version_id: string;
    body: { render_schema_version?: unknown; field_schema?: unknown; internal_notes?: unknown };
    requestId: string;
  }) {
    const auth = await this.studio(input, 'author');
    const b = input.body;
    return this.d.tenantTemplates.updateVersion(
      auth,
      input.version_id,
      {
        ...('field_schema' in b ? { field_schema: b.field_schema } : {}),
        ...(typeof b.render_schema_version === 'string' ? { render_schema_version: b.render_schema_version } : {}),
        ...('internal_notes' in b ? { internal_notes: b.internal_notes as string | null } : {}),
      },
      input.requestId,
    );
  }

  async discardDraft(input: { tenant_id: string; actor_id: string; version_id: string; requestId: string }): Promise<void> {
    await this.d.tenantTemplates.deleteDraft(await this.studio(input, 'author'), input.version_id, input.requestId);
  }

  async previewVersion(input: { tenant_id: string; actor_id: string; version_id: string; requestId: string }) {
    return this.d.tenantTemplates.previewVersion(await this.studio(input, 'author'), input.version_id, input.requestId);
  }

  /** "Use this version" (the Personal word for Approve & activate). */
  async activate(input: { tenant_id: string; actor_id: string; version_id: string; requestId: string }) {
    return this.d.tenantTemplates.activate(await this.studio(input, 'manage'), input.version_id, input.requestId);
  }
}
