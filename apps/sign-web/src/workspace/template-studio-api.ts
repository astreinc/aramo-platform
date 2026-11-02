import { apiClient } from '@aramo/fe-foundation';
import type {
  DocumentTemplateView,
  OrganizationStudioApi,
  TemplateDefaultPreview,
  TemplateLibraryItem,
  TemplateLibraryView,
  TemplateSamplePreview,
  TemplateVersionView,
} from '@aramo/document-templates-web';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.3 / §8.5 — the Sign side
// of the template Studio and of "Use as it is". Every call goes to sign-service
// (/v1/sign/sender/templates/{library,studio}*), which forwards it to Documents over the signed
// service-to-service channel; Sign stores nothing. The Studio calls mirror the tenant client the
// shared Studio's organization source uses (/v1/document-templates*), so the SAME data source
// runs unchanged on top of them (the Sign data source = organization source + these calls).

const BASE = '/v1/sign/sender/templates';
const STUDIO = `${BASE}/studio`;
const enc = encodeURIComponent;

/** One Aramo default tagged `sign` (the gallery; every account kind). */
export interface SignGalleryItem {
  readonly template_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly document_type: { readonly id: string; readonly name: string | null };
  readonly products: readonly string[];
  readonly version_id: string;
  readonly version_number: number | null;
  readonly updated_at: string;
  /** The account's own copy of this default, or null while it is not in "My templates". */
  readonly adopted_template_id: string | null;
}

/** The Studio list: the account's own templates + the Aramo defaults tagged `sign`. */
export interface SignStudioList extends TemplateLibraryView {
  readonly items: ReadonlyArray<TemplateLibraryItem & { readonly adopted_template_id: string | null }>;
}

export const signTemplateGalleryApi = {
  gallery: () => apiClient.get<{ items: SignGalleryItem[] }>(`${BASE}/library`),
  previewDefault: (id: string) => apiClient.get<TemplateDefaultPreview>(`${BASE}/library/${enc(id)}/preview`),
  /** §8.5 — adopt + approve the unchanged copy (it becomes the current version for its type). */
  adoptAndUse: (id: string) =>
    apiClient.post<{ template: DocumentTemplateView; version: TemplateVersionView }>(`${BASE}/library/${enc(id)}/adopt-and-use`, {}),
  studioList: () => apiClient.get<SignStudioList>(STUDIO),
  adopt: (id: string) =>
    apiClient.post<{ template: DocumentTemplateView; version: TemplateVersionView }>(`${STUDIO}/adopt`, { library_template_id: id }),
};

const unavailable = (): never => {
  throw new Error('A logo isn’t available for a personal account.');
};

/** The tenant-client calls of the shared Studio's organization source, over Sign. */
export const SIGN_STUDIO_API: OrganizationStudioApi = {
  getTemplate: (id) => apiClient.get<DocumentTemplateView>(`${STUDIO}/${enc(id)}`),
  listVersions: (id) => apiClient.get<TemplateVersionView[]>(`${STUDIO}/${enc(id)}/versions`),
  catalog: async (id) => {
    const res = await apiClient.get<{ bindings: { key: string; label: string; group: string }[]; tenant_logo?: { available: boolean; tenant_name: string } | null }>(
      `${STUDIO}/${enc(id)}/allowed-bindings`,
    );
    return { bindings: res.bindings, tenantLogo: res.tenant_logo ?? null };
  },
  library: () => apiClient.get<TemplateLibraryView>(STUDIO),
  createVersion: (id, input) => apiClient.post<TemplateVersionView>(`${STUDIO}/${enc(id)}/versions`, input),
  createDraftFromActive: (id) => apiClient.post<TemplateVersionView>(`${STUDIO}/${enc(id)}/draft`, {}),
  updateDraft: (versionId, input) => apiClient.patch<TemplateVersionView>(`${STUDIO}/versions/${enc(versionId)}`, input),
  discardDraft: async (versionId) => {
    await apiClient.delete<undefined>(`${STUDIO}/versions/${enc(versionId)}`);
  },
  preview: (versionId) => apiClient.post<TemplateSamplePreview>(`${STUDIO}/versions/${enc(versionId)}/preview`, {}),
  activate: (versionId) => apiClient.post<TemplateVersionView>(`${STUDIO}/versions/${enc(versionId)}/activate`, {}),
  rename: (id, input) => apiClient.patch<DocumentTemplateView>(`${STUDIO}/${enc(id)}`, input),
  // §8.2 — a Personal account's letterhead is the person's name: no organization logo.
  captureLogo: async () => unavailable(),
  removeLogo: async () => unavailable(),
  logoUrl: () => '',
};
