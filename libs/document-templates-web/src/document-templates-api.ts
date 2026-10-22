// DOC-TEMPLATE-ADMIN-RTR-1 (§38) — the tenant document-template ADMIN client
// (ats-web, Settings → Documents → Document templates). Thin surface over the
// generic /v1/document-templates API; NO template business truth lives here. The
// backend is authoritative for: the DRAFT→ACTIVE lifecycle, ACTIVE/RETIRED
// immutability, the one-DRAFT invariant, the §18 preview-before-approve gate, and
// the closed §15 binding catalog. Types are hand-mirrored (ats-web must NOT import
// @aramo/documents — a forbidden domain edge) and track the server rows. RBAC
// mirrors the server (ORG-UX-1 Directive v1.0 LOCKED §4.1): document_template:read →
// view; :author → adopt / create / edit, preview and discard drafts / logo / fields;
// :manage → approve (activate) and selections. A manage holder may author too.

import { apiClient } from '@aramo/fe-foundation';

const BASE = '/v1/document-templates';

export const DOC_TEMPLATE_READ_SCOPE = 'document_template:read';
export const DOC_TEMPLATE_MANAGE_SCOPE = 'document_template:manage';
export const DOC_TEMPLATE_AUTHOR_SCOPE = 'document_template:author';

// ORG-UX-1 §4.1 — UX affordance helpers (the server is the boundary). Authoring is
// author-or-manage; approval (activate) and selections stay manage-only, so an author
// never sees Approve. Reading the screens is open to any of the three scopes.
type ScopedSession = { readonly scopes: readonly string[] } | null | undefined;
export function canAuthorTemplates(session: ScopedSession): boolean {
  return session != null && (session.scopes.includes(DOC_TEMPLATE_AUTHOR_SCOPE) || session.scopes.includes(DOC_TEMPLATE_MANAGE_SCOPE));
}
export function canApproveTemplates(session: ScopedSession): boolean {
  return session != null && session.scopes.includes(DOC_TEMPLATE_MANAGE_SCOPE);
}
export function canReadTemplates(session: ScopedSession): boolean {
  return session != null && (session.scopes.includes(DOC_TEMPLATE_READ_SCOPE) || canAuthorTemplates(session));
}

// The seeded Right-to-Represent DocumentType id (public, non-secret; mirrors the
// server RIGHT_TO_REPRESENT_TYPE_ID). The RTR detail resolves the tenant's template
// by this type; RTR is the only tenant-configurable type this increment.
export const RIGHT_TO_REPRESENT_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';

// §12 — the RTR generated-content schema version. A new DRAFT starts at this version.
export const RTR_GENERATED_SCHEMA_V1 = 'rtr-generated-v1';
// Amendment A1 — allowlisted-HTML content (field_schema { render_schema_version, title, html }).
// New drafts copied from a v1 ACTIVE arrive as rtr-html-v1; an existing v1 DRAFT stays v1.
export const RTR_HTML_SCHEMA_V1 = 'rtr-html-v1';

export type TemplateStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

export interface DocumentTemplateView {
  readonly id: string;
  readonly tenant_id: string;
  readonly document_type_id: string;
  readonly client_id: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly template_kind: string;
  readonly status: TemplateStatus;
  readonly current_version_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  // ORG-UX-1 §5.1 — provenance of an adopted template (audit/display only; ADD-only,
  // optional in this mirror).
  readonly adopted_from_template_id?: string | null;
  readonly adopted_from_version_id?: string | null;
}

export interface TemplateVersionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly template_id: string;
  readonly version_number: number;
  readonly status: TemplateStatus;
  readonly render_schema_version: string;
  readonly field_schema: unknown;
  readonly binding_schema: unknown;
  readonly created_by: string;
  readonly created_at: string;
  readonly activated_at: string | null;
  readonly activated_by: string | null;
  readonly retired_at: string | null;
  // §18 preview-revision gate markers — the editor arms/reads the gate from these.
  readonly content_fingerprint: string | null;
  readonly previewed_fingerprint: string | null;
  // Admin-only usage guidance (≤500). OPTIONAL in this mirror: the editor renders the
  // field only when the server's version view carries the property (no dead control).
  readonly internal_notes?: string | null;
  // A1 — the version's captured tenant-logo asset (the letterhead), when any.
  readonly logo?: TemplateLogo | null;
}

export interface TemplateLogo { readonly asset_id: string; readonly mime: string }
export interface TenantLogoInfo { readonly available: boolean; readonly tenant_name: string }
export interface SampleValue { readonly key: string; readonly label: string; readonly value: string }

// §15 — one governed Insert-field binding (the server's closed catalog; the editor
// generates its Insert menu from this, so there is no FE mirror to drift, §14).
export interface TemplateBinding {
  readonly key: string;
  readonly label: string;
  readonly group: string;
}

// §17 — a fixed-sample preview: the draft content with every binding substituted by
// its SAFE sample value. Structured resolved blocks (no business Document created).
export interface TemplateSamplePreview {
  readonly title: string;
  // v1: resolved blocks. rtr-html-v1: `html` with <span data-sample="key">value</span>.
  readonly blocks?: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly html?: string;
  readonly logo?: { readonly asset_id: string; readonly mime?: string } | null;
  readonly sample_values?: readonly SampleValue[];
  // OPTIONAL: present when the server appends the fixed Aramo e-sign signature block to
  // the render. The FE draws the signature in a preview ONLY when this is present.
  readonly signature_block?: { readonly printed_name: string | null } | null;
}

export async function listDocumentTemplates(): Promise<readonly DocumentTemplateView[]> {
  return apiClient.get<DocumentTemplateView[]>(BASE);
}

export async function getDocumentTemplate(id: string): Promise<DocumentTemplateView> {
  return apiClient.get<DocumentTemplateView>(`${BASE}/${encodeURIComponent(id)}`);
}

export async function listTemplateVersions(templateId: string): Promise<readonly TemplateVersionView[]> {
  return apiClient.get<TemplateVersionView[]>(`${BASE}/${encodeURIComponent(templateId)}/versions`);
}

export async function getTemplateVersion(versionId: string): Promise<TemplateVersionView> {
  return apiClient.get<TemplateVersionView>(`${BASE}/versions/${encodeURIComponent(versionId)}`);
}

export async function listAllowedBindings(templateId: string): Promise<readonly TemplateBinding[]> {
  const res = await apiClient.get<{ bindings: TemplateBinding[] }>(
    `${BASE}/${encodeURIComponent(templateId)}/allowed-bindings`,
  );
  return res.bindings;
}

// A1 — the governed catalog + whether the tenant has a profile logo to place.
export interface TemplateCatalog { readonly bindings: readonly TemplateBinding[]; readonly tenantLogo: TenantLogoInfo | null }
export async function fetchTemplateCatalog(templateId: string): Promise<TemplateCatalog> {
  const res = await apiClient.get<{ bindings: TemplateBinding[]; tenant_logo?: TenantLogoInfo | null }>(
    `${BASE}/${encodeURIComponent(templateId)}/allowed-bindings`,
  );
  return { bindings: res.bindings, tenantLogo: res.tenant_logo ?? null };
}

// A1 — capture the Tenant-profile logo onto the DRAFT version (409 reason=no_tenant_logo
// when the tenant has none) / remove it (the reference AND the node; 204). The logo
// reference is server-owned (carried over on PATCH). Letterhead bytes: logo/content.
// The server stores the reference AND places the logo node first in the draft html;
// it answers 201 { asset_id, sha256, mime }.
export interface CapturedLogo { readonly asset_id: string; readonly sha256?: string; readonly mime: string }
export async function captureVersionLogo(versionId: string): Promise<CapturedLogo> {
  return apiClient.post<CapturedLogo>(`${BASE}/versions/${encodeURIComponent(versionId)}/logo`, {});
}
export async function removeVersionLogo(versionId: string): Promise<void> {
  await apiClient.delete<undefined>(`${BASE}/versions/${encodeURIComponent(versionId)}/logo`);
}
export function versionLogoUrl(versionId: string, assetId: string | null): string {
  return `${BASE}/versions/${encodeURIComponent(versionId)}/logo/content${assetId != null ? `?v=${encodeURIComponent(assetId)}` : ''}`;
}

// Rename the template (document_template:author). The name is a TEMPLATE attribute
// (shared by every version), not draft content — it does not re-arm the §18 gate.
export async function updateDocumentTemplate(id: string, input: { name: string }): Promise<DocumentTemplateView> {
  return apiClient.patch<DocumentTemplateView>(`${BASE}/${encodeURIComponent(id)}`, input);
}

// Discard the open DRAFT version (204; DRAFT-only — ACTIVE/RETIRED are immutable and the
// backend refuses them). The active version is unchanged.
export async function deleteDraftVersion(versionId: string): Promise<void> {
  await apiClient.delete<undefined>(`${BASE}/versions/${encodeURIComponent(versionId)}`);
}

// Open a new editable DRAFT (vN+1). The backend copies the current ACTIVE content as
// the starting point (§8) and refuses (409 TEMPLATE_DRAFT_ALREADY_EXISTS) if one is open.
export async function createDraftFromActive(templateId: string): Promise<TemplateVersionView> {
  return apiClient.post<TemplateVersionView>(`${BASE}/${encodeURIComponent(templateId)}/draft`, {});
}

// Save DRAFT content (DRAFT-only; re-arms the §18 preview gate server-side).
export async function updateDraftVersion(
  versionId: string,
  input: { field_schema: unknown; render_schema_version?: string; internal_notes?: string | null },
): Promise<TemplateVersionView> {
  return apiClient.patch<TemplateVersionView>(`${BASE}/versions/${encodeURIComponent(versionId)}`, input);
}

// Fixed-sample preview of the CURRENT draft content (validates + substitutes safe
// sample values; records the preview to satisfy the §18 approve gate).
export async function previewTemplateVersion(versionId: string): Promise<TemplateSamplePreview> {
  return apiClient.post<TemplateSamplePreview>(`${BASE}/versions/${encodeURIComponent(versionId)}/preview`, {});
}

// Approve & activate: DRAFT→ACTIVE, prior ACTIVE→RETIRED, moves current_version_id.
// Fail-closed on unsupported bindings (422) / un-previewed content (409).
export async function activateTemplateVersion(versionId: string): Promise<TemplateVersionView> {
  return apiClient.post<TemplateVersionView>(`${BASE}/versions/${encodeURIComponent(versionId)}/activate`, {});
}

// DOC-TEMPLATE-LIB-1 T-4 — author / approver display names for the version history
// (moved from ats-web's users-api with the screens). The tenant user directory read
// (tenant:user:read:directory, carried by the org and recruiter sessions). Best-effort:
// on any failure the map is empty and the caller falls back to the id.
const DIRECTORY_PATH = '/v1/tenant/users/directory';
export async function resolveUserNames(userIds?: readonly string[]): Promise<Record<string, string>> {
  let path = DIRECTORY_PATH;
  if (userIds !== undefined) {
    const unique = [...new Set(userIds.filter((id) => id.length > 0))];
    if (unique.length === 0) return {};
    path = `${DIRECTORY_PATH}?user_ids=${encodeURIComponent(unique.join(','))}`;
  }
  try {
    const view = await apiClient.get<{ items?: ReadonlyArray<{ user_id: string; display_name: string | null }> }>(path);
    const map: Record<string, string> = {};
    for (const u of view.items ?? []) {
      if (u.display_name !== null) map[u.user_id] = u.display_name;
    }
    return map;
  } catch {
    return {};
  }
}

// ── DOC-TEMPLATE-LIB-1 T-4 — the Org Home template library (§8.2) ──────────────────
// Gallery (own templates ∪ Aramo defaults, current version only), the branded preview of
// an Aramo default, the active choice per document type, and "Create your own document
// template" (a TENANT template written from scratch — there is no copy function).

export type TemplateOwnerScope = 'PLATFORM' | 'TENANT';

export interface TemplateLibraryItem {
  readonly id: string;
  readonly owner_scope: TemplateOwnerScope;
  readonly document_type_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly template_kind: string;
  readonly status: TemplateStatus;
  readonly client_id: string | null;
  readonly current_version_id: string | null;
  readonly current_version_number: number | null;
  readonly updated_at: string;
  readonly products: readonly string[] | null;
  readonly withdraw_effective_at: string | null;
  readonly configurable: boolean;
}

export interface TemplateDocumentType {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly configurable: boolean;
}

export interface TemplateLibraryView {
  readonly items: readonly TemplateLibraryItem[];
  readonly document_types: readonly TemplateDocumentType[];
}

export interface TemplateDefaultPreview extends TemplateSamplePreview {
  readonly template_id: string;
  readonly version_id: string;
  readonly version_number: number;
  readonly updated_at: string;
  readonly letterhead: { readonly organization_name: string | null; readonly logo_available: boolean };
}

export interface TemplateSelectionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly document_type_id: string;
  readonly client_id: string | null;
  readonly template_id: string;
  readonly selected_by: string;
  readonly selected_at: string;
  // ORG-UX-1 §5.3 (T-A) — a grandfathered selection of an Aramo default (nullable flag).
  readonly legacy_platform?: boolean | null;
}

export async function fetchTemplateLibrary(): Promise<TemplateLibraryView> {
  return apiClient.get<TemplateLibraryView>(`${BASE}/library`);
}

export async function previewTemplateDefault(templateId: string): Promise<TemplateDefaultPreview> {
  return apiClient.get<TemplateDefaultPreview>(`${BASE}/library/${encodeURIComponent(templateId)}/preview`);
}

export async function listTemplateSelections(): Promise<readonly TemplateSelectionView[]> {
  const res = await apiClient.get<{ items: TemplateSelectionView[] }>(`${BASE}/selections`);
  return res.items;
}

// Selections are document_template:manage. ORG-UX-1 §5.3: PUT accepts only approved
// TENANT templates (a PLATFORM id → 422 platform_template_not_selectable); activation
// already sets the tenant-wide selection, so the Org pages offer no selection control.
export async function setTemplateSelection(input: {
  document_type_id: string;
  client_id?: string | null;
  template_id: string;
}): Promise<TemplateSelectionView> {
  return apiClient.put<TemplateSelectionView>(`${BASE}/selections`, input);
}

export async function clearTemplateSelection(input: { document_type_id: string; client_id?: string | null }): Promise<void> {
  const q = new URLSearchParams({ document_type_id: input.document_type_id });
  if (input.client_id != null) q.set('client_id', input.client_id);
  await apiClient.delete<undefined>(`${BASE}/selections?${q.toString()}`);
}

// "Create your own document template" (ADR-0034 D5): a new TENANT template for the chosen
// document type plus an EMPTY first draft. Never pre-filled from an Aramo default.
export async function createOwnTemplate(input: {
  document_type_id: string;
  name: string;
  description?: string;
}): Promise<{ template: DocumentTemplateView; draft: TemplateVersionView }> {
  const template = await apiClient.post<DocumentTemplateView>(BASE, {
    document_type_id: input.document_type_id,
    name: input.name,
    template_kind: 'GENERATED',
    ...(input.description !== undefined && input.description.length > 0 ? { description: input.description } : {}),
  });
  const draft = await apiClient.post<TemplateVersionView>(`${BASE}/${encodeURIComponent(template.id)}/versions`, {
    render_schema_version: RTR_HTML_SCHEMA_V1,
    field_schema: { render_schema_version: RTR_HTML_SCHEMA_V1, title: input.name, html: '' },
  });
  return { template, draft };
}

// ORG-UX-1 §5.1 (Lead Correction B) — ADOPT an Aramo gallery default: an independent
// TENANT-owned template plus a DRAFT v1 holding a full copy of the default's current
// content (document_template:author). Nothing is used until it is approved.
export async function adoptTemplate(
  libraryTemplateId: string,
): Promise<{ template: DocumentTemplateView; version: TemplateVersionView }> {
  return apiClient.post<{ template: DocumentTemplateView; version: TemplateVersionView }>(`${BASE}/adopt`, {
    library_template_id: libraryTemplateId,
  });
}
