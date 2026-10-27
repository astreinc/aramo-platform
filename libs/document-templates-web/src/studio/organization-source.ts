import {
  activateTemplateVersion,
  canApproveTemplates,
  canAuthorTemplates,
  captureVersionLogo,
  createDraftFromActive,
  createTemplateVersion,
  deleteDraftVersion,
  fetchTemplateCatalog,
  fetchTemplateLibrary,
  getDocumentTemplate,
  listTemplateVersions,
  previewTemplateVersion,
  removeVersionLogo,
  updateDocumentTemplate,
  updateDraftVersion,
  versionLogoUrl,
  type DocumentTemplateView,
  type TemplateLibraryView,
  type TemplateSamplePreview,
  type TemplateVersionView,
} from '../document-templates-api';

import {
  LETTERHEAD_STUDIO_CONTENT_CODEC,
  type StudioCatalogVariable,
  type StudioSamplePreview,
  type StudioSection,
  type StudioTemplate,
  type StudioTemplateInfo,
  type StudioVersion,
  type TemplateStudioDataSource,
} from './data-source';
import { organizationStudioCopy, type OrganizationStudioCopyOptions } from './studio-copy';

// TEMPLATE-STUDIO-1 S-1 (directive §2, §3) — the ORGANIZATION data source of the shared
// Template Studio, over the tenant client (/v1/document-templates*): a tenant template —
// edit (document_template:author) or edit + approve (document_template:manage), else
// read-only. No withdrawal, no product tags, no tenant description (§8).
// The server stays authoritative for every rule (the §18 preview gate, A1 logo matching,
// the closed binding catalog); capabilities only hide controls.

type ScopedSession = Parameters<typeof canAuthorTemplates>[0];

/** The tenant client calls the organization source uses (a test seam). */
export interface OrganizationStudioApi {
  readonly getTemplate: typeof getDocumentTemplate;
  readonly listVersions: typeof listTemplateVersions;
  readonly catalog: typeof fetchTemplateCatalog;
  readonly library: typeof fetchTemplateLibrary;
  readonly createVersion: typeof createTemplateVersion;
  readonly createDraftFromActive: typeof createDraftFromActive;
  readonly updateDraft: typeof updateDraftVersion;
  readonly discardDraft: typeof deleteDraftVersion;
  readonly preview: typeof previewTemplateVersion;
  readonly activate: typeof activateTemplateVersion;
  readonly rename: typeof updateDocumentTemplate;
  readonly captureLogo: typeof captureVersionLogo;
  readonly removeLogo: typeof removeVersionLogo;
  readonly logoUrl: typeof versionLogoUrl;
}

export const ORGANIZATION_STUDIO_API: OrganizationStudioApi = {
  getTemplate: getDocumentTemplate,
  listVersions: listTemplateVersions,
  catalog: fetchTemplateCatalog,
  library: fetchTemplateLibrary,
  createVersion: createTemplateVersion,
  createDraftFromActive,
  updateDraft: updateDraftVersion,
  discardDraft: deleteDraftVersion,
  preview: previewTemplateVersion,
  activate: activateTemplateVersion,
  rename: updateDocumentTemplate,
  captureLogo: captureVersionLogo,
  removeLogo: removeVersionLogo,
  logoUrl: versionLogoUrl,
};

const field = (key: string): string => `<span data-field="${key}"></span>`;

/**
 * Directive §7.2 — the Organization Sections set, built ONLY from existing catalog
 * variables (RTR: talent.*, client.name, requisition.*, recruiting_company.name,
 * recruiter.display_name). No "Agreed pay rate" section (A2 :14 until AGREED-PAY-1); the
 * handoff's "Right to withdraw" is reworded (vocabulary gate). Insert copies the content
 * into the draft; there is no shared store and no usage count.
 */
export const ORGANIZATION_STUDIO_SECTIONS: readonly StudioSection[] = [
  {
    key: 'representation',
    name: 'Representation clause',
    description: 'Authorizes your firm to represent the talent to one client for one requisition.',
    html: `<p>I, ${field('talent.full_name')}, authorize ${field('recruiting_company.name')} to represent me to ${field('client.name')} for the ${field('requisition.title')} requisition (${field('requisition.reference')}).</p>`,
  },
  {
    key: 'job-description',
    name: 'Job description',
    description: 'An “About the role” heading followed by the requisition’s job description.',
    html: `<h2>About the role</h2><p>${field('requisition.description')}</p>`,
  },
  {
    key: 'exclusivity',
    name: 'Exclusivity',
    description: 'Confirms no other firm represents the talent to this client for this role.',
    html: `<p>I have not authorized any other firm to represent me to ${field('client.name')} for this role.</p>`,
  },
  {
    key: 'right-to-stop',
    name: 'Right to stop representation',
    description: 'The talent can end this authorization in writing before their profile is sent.',
    html: `<p>I can end this authorization at any time by telling ${field('recruiting_company.name')} in writing before my profile is sent to ${field('client.name')}.</p>`,
  },
  {
    key: 'recruiter-sign-off',
    name: 'Recruiter sign-off',
    description: 'Closes with the sending recruiter’s name and your organization.',
    html: `<p>Your recruiter: ${field('recruiter.display_name')}, ${field('recruiting_company.name')}</p>`,
  },
];

function studioVersion(v: TemplateVersionView): StudioVersion {
  return {
    id: v.id,
    version_number: v.version_number,
    status: v.status,
    render_schema_version: v.render_schema_version,
    field_schema: v.field_schema,
    activated_at: v.activated_at,
    created_at: v.created_at,
    content_fingerprint: v.content_fingerprint,
    previewed_fingerprint: v.previewed_fingerprint,
    logo: v.logo ?? null,
  };
}

function studioInfo(t: DocumentTemplateView, versions: readonly TemplateVersionView[]): StudioTemplateInfo {
  const cur = t.current_version_id !== null ? versions.find((v) => v.id === t.current_version_id) : undefined;
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    status: t.status,
    document_type_id: t.document_type_id,
    products: [],
    current_version:
      t.current_version_id !== null ? { id: t.current_version_id, version_number: cur?.version_number ?? 0 } : null,
    withdraw_effective_at: null,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function studioPreview(p: TemplateSamplePreview): StudioSamplePreview {
  return {
    title: p.title,
    ...(p.html !== undefined ? { html: p.html } : {}),
    ...(p.sample_values !== undefined ? { sample_values: p.sample_values } : {}),
    logo: p.logo != null ? { asset_id: p.logo.asset_id } : null,
  };
}

/** A tenant allowed-binding (B-2 metadata) as a Studio catalog variable. */
function catalogVariable(b: { key: string; label: string; group: string; data_type?: string; sample_value?: string | null; active?: boolean }): StudioCatalogVariable {
  return { key: b.key, label: b.label, group_label: b.group, data_type: b.data_type ?? '', sample_value: b.sample_value ?? null, active: b.active ?? true };
}

export interface OrganizationStudioSourceOptions extends OrganizationStudioCopyOptions {
  readonly session: ScopedSession;
  readonly api?: Partial<OrganizationStudioApi>;
}

/** S-1 — a tenant template in the shared Studio (directive §3). */
export function organizationStudioDataSource(o: OrganizationStudioSourceOptions): TemplateStudioDataSource {
  const api: OrganizationStudioApi = { ...ORGANIZATION_STUDIO_API, ...o.api };
  const canEdit = canAuthorTemplates(o.session);
  const canApprove = canApproveTemplates(o.session);
  return {
    load: async (id): Promise<StudioTemplate> => {
      const [t, versions] = await Promise.all([api.getTemplate(id), api.listVersions(id)]);
      return { ...studioInfo(t, versions), versions: versions.map(studioVersion) };
    },
    catalog: async (id) => {
      const [cat, lib] = await Promise.all([api.catalog(id), api.library().catch((): TemplateLibraryView | null => null)]);
      return {
        variables: cat.bindings.map(catalogVariable),
        bindings: cat.bindings.map((b) => ({ key: b.key, label: b.label, group: b.group })),
        documentTypes: lib?.document_types.map((d) => ({ id: d.id, name: d.name })) ?? [],
        tenantLogo: cat.tenantLogo,
      };
    },
    // A template with an ACTIVE version opens its draft from that version (POST /:id/draft
    // copies the content AND the server-owned logo reference, A1), then saves the editor's
    // content onto it; a template without one opens a draft with the content directly.
    createDraft: async (id, body) => {
      const t = await api.getTemplate(id);
      if (t.current_version_id !== null) {
        const d = await api.createDraftFromActive(id);
        return studioVersion(await api.updateDraft(d.id, { render_schema_version: body.render_schema_version, field_schema: body.field_schema }));
      }
      return studioVersion(await api.createVersion(id, { render_schema_version: body.render_schema_version, field_schema: body.field_schema }));
    },
    saveDraft: async (versionId, body) =>
      studioVersion(await api.updateDraft(versionId, { render_schema_version: body.render_schema_version, field_schema: body.field_schema })),
    discardDraft: (versionId) => api.discardDraft(versionId),
    preview: async (versionId) => studioPreview(await api.preview(versionId)),
    approve: async (versionId) => studioVersion(await api.activate(versionId)),
    // Name only: the tenant description and product tags are not shipped (§8; DB CHECK).
    updateProperties: async (id, patch) => {
      if (patch.name === undefined) throw new Error('Only the name can be changed here.');
      const t = await api.rename(id, { name: patch.name });
      const versions = await api.listVersions(id).catch((): readonly TemplateVersionView[] => []);
      return studioInfo(t, versions);
    },
    letterhead: {
      capture: (versionId) => api.captureLogo(versionId),
      remove: (versionId) => api.removeLogo(versionId),
      logoUrl: (versionId, assetId) => api.logoUrl(versionId, assetId),
    },
    sections: ORGANIZATION_STUDIO_SECTIONS,
    capabilities: { canEdit, canApprove: canEdit && canApprove, canWithdraw: false, productTags: false, description: false },
    copy: organizationStudioCopy(o),
    content: LETTERHEAD_STUDIO_CONTENT_CODEC,
  };
}
