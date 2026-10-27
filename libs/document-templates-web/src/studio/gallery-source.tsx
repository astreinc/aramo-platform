import {
  RTR_HTML_SCHEMA_V1,
  previewTemplateDefault,
  type TemplateDefaultPreview,
  type TemplateLibraryItem,
  type TemplateLibraryView,
} from '../document-templates-api';
import { sanitizeDocHtml } from '../dt-html';

import type { StudioCatalogData, StudioTemplate, TemplateStudioCopy, TemplateStudioDataSource } from './data-source';
import { organizationStudioCopy } from './studio-copy';

// TEMPLATE-STUDIO-1 S-2 (directive §2 "Read-only gallery source", §4.3; ADR-0034 D3) — the
// Org Template gallery's READ-ONLY data source: an Aramo (PLATFORM) default opened in the
// shared Studio, Preview only.
//   load      = the library item (GET /v1/document-templates/library) + its CURRENT version
//               only (GET /library/:id/preview: version id + number, rendered content)
//   catalog   = the preview's sample values (the keys the current version uses)
//   previewCurrent = GET /library/:id/preview — rendered with the tenant's branding
//   writes    = none: createDraft / saveDraft / preview / approve refuse (the Studio never
//               calls them while canEdit and canApprove are false). Adopt is the host's
//               action (POST /adopt), not part of this source.
// Versions and Compare are hidden (capabilities.versions false): tenants see only the
// current version of a default (D3). So are the Edit | Preview toggle, the readiness pill
// and the Checks tab (capabilities.modeToggle / checks false): a default is never edited
// here. The server stays authoritative.

export const GALLERY_STUDIO_READ_ONLY = 'An Aramo default is read only. Adopt it to make your own draft.';

/** The rendered sample html → stored rtr-html-v1 (each sample value back to its variable). */
export function galleryContentFromSample(html: string): string {
  return sanitizeDocHtml(html, { allowSample: true }).replace(/<span data-sample="([A-Za-z0-9_.]+)">[^<]*<\/span>/g, '<span data-field="$1"></span>');
}

function groupOf(key: string): string {
  const head = key.split('.')[0] ?? key;
  return head === '' ? 'Variables' : head.charAt(0).toUpperCase() + head.slice(1).replace(/_/g, ' ');
}

/**
 * The read-only Studio copy for an Aramo default in the Org gallery: the organization copy
 * table (S-1) with the gallery crumb, the Aramo-default read-only bar and scope card.
 */
export function galleryStudioCopy(o: { readonly organizationHref: string | null; readonly listHref: string; readonly galleryTo: string }): TemplateStudioCopy {
  return {
    ...organizationStudioCopy({ organizationHref: o.organizationHref, listHref: o.listHref }),
    crumbs: [o.organizationHref !== null ? { label: 'Organization', to: o.organizationHref } : { label: 'Organization' }, { label: 'Template gallery', to: o.galleryTo }],
    back: { to: o.galleryTo, label: 'Back to the template gallery' },
    checksNote: 'An Aramo default is shown as published. Adopt it to edit, preview and approve your own version.',
    viewOnly: (
      <>
        <b>Aramo default.</b> You&apos;re seeing the current version with your organization&apos;s details. Adopting it creates a draft in Our templates; nothing is used until it&apos;s approved.
      </>
    ),
    scopeCard: 'Aramo default · read only. Adopt it to create your organization’s own draft in Our templates.',
  };
}

export interface GallerySourceOptions {
  /** The tenant's library (GET /v1/document-templates/library) — shared with the host. */
  readonly library: Promise<TemplateLibraryView>;
  /** GET /v1/document-templates/library/:id/preview. */
  readonly previewFn?: (templateId: string) => Promise<TemplateDefaultPreview>;
  /** The gallery path (crumb + narrow-width back link). */
  readonly galleryTo: string;
  /** Our templates (the list). */
  readonly listHref: string;
  /** The Organization crumb's link (org admins); null for template authors. */
  readonly organizationHref?: string | null;
}

function refuse(): Promise<never> {
  return Promise.reject(new Error(GALLERY_STUDIO_READ_ONLY));
}

/** The PLATFORM library item with this id (null when it is not a published Aramo default). */
export function galleryDefaultOf(library: TemplateLibraryView, templateId: string): TemplateLibraryItem | null {
  return library.items.find((i) => i.id === templateId && i.owner_scope === 'PLATFORM') ?? null;
}

export function galleryStudioDataSource({ library, previewFn = previewTemplateDefault, galleryTo, listHref, organizationHref = null }: GallerySourceOptions): TemplateStudioDataSource {
  // One preview read per template (load, catalog and previewCurrent share it).
  const previews = new Map<string, Promise<TemplateDefaultPreview>>();
  const previewOf = (id: string): Promise<TemplateDefaultPreview> => {
    let p = previews.get(id);
    if (p === undefined) {
      p = previewFn(id);
      previews.set(id, p);
    }
    return p;
  };

  return {
    load: async (templateId): Promise<StudioTemplate> => {
      const [lib, pv] = await Promise.all([library, previewOf(templateId)]);
      const item = galleryDefaultOf(lib, templateId);
      if (item === null) throw new Error('This Aramo default isn’t available.');
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        status: item.status,
        document_type_id: item.document_type_id,
        products: [],
        current_version: { id: pv.version_id, version_number: pv.version_number },
        withdraw_effective_at: null,
        created_at: item.updated_at,
        updated_at: pv.updated_at,
        // D3: the current version only.
        versions: [
          {
            id: pv.version_id,
            version_number: pv.version_number,
            status: 'ACTIVE',
            render_schema_version: RTR_HTML_SCHEMA_V1,
            field_schema: { render_schema_version: RTR_HTML_SCHEMA_V1, title: pv.title, html: galleryContentFromSample(pv.html ?? '') },
            activated_at: pv.updated_at,
            created_at: pv.updated_at,
            content_fingerprint: null,
            previewed_fingerprint: null,
          },
        ],
      };
    },
    catalog: async (templateId): Promise<StudioCatalogData> => {
      const [lib, pv] = await Promise.all([library, previewOf(templateId)]);
      const samples = pv.sample_values ?? [];
      return {
        variables: samples.map((v) => ({ key: v.key, label: v.label, group_label: groupOf(v.key), data_type: 'TEXT', sample_value: v.value, active: true })),
        bindings: samples.map((v) => ({ key: v.key, label: v.label, group: groupOf(v.key) })),
        documentTypes: lib.document_types.map((t) => ({ id: t.id, name: t.name })),
      };
    },
    createDraft: refuse,
    saveDraft: refuse,
    preview: refuse,
    approve: refuse,
    previewCurrent: (templateId) => previewOf(templateId),
    capabilities: { canEdit: false, canApprove: false, canWithdraw: false, productTags: false, description: true, versions: false, modeToggle: false, checks: false },
    copy: galleryStudioCopy({ organizationHref, listHref, galleryTo }),
  };
}
