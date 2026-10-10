// DOC-TEMPLATE-ADMIN-RTR-1 (§38) — the tenant document-template ADMIN client
// (ats-web, Settings → Documents → Document templates). Thin surface over the
// generic /v1/document-templates API; NO template business truth lives here. The
// backend is authoritative for: the DRAFT→ACTIVE lifecycle, ACTIVE/RETIRED
// immutability, the one-DRAFT invariant, the §18 preview-before-approve gate, and
// the closed §15 binding catalog. Types are hand-mirrored (ats-web must NOT import
// @aramo/documents — a forbidden domain edge) and track the server rows. RBAC
// mirrors the server: document_template:read → view; :manage → mutate.

import { apiClient } from '@aramo/fe-foundation';

const BASE = '/v1/document-templates';

export const DOC_TEMPLATE_READ_SCOPE = 'document_template:read';
export const DOC_TEMPLATE_MANAGE_SCOPE = 'document_template:manage';

// The seeded Right-to-Represent DocumentType id (public, non-secret; mirrors the
// server RIGHT_TO_REPRESENT_TYPE_ID). The RTR detail resolves the tenant's template
// by this type; RTR is the only tenant-configurable type this increment.
export const RIGHT_TO_REPRESENT_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';

// §12 — the RTR generated-content schema version. A new DRAFT starts at this version.
export const RTR_GENERATED_SCHEMA_V1 = 'rtr-generated-v1';

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
}

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
  readonly blocks: ReadonlyArray<{ readonly type: string; readonly text: string }>;
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

// Open a new editable DRAFT (vN+1). The backend copies the current ACTIVE content as
// the starting point (§8) and refuses (409 TEMPLATE_DRAFT_ALREADY_EXISTS) if one is open.
export async function createDraftFromActive(templateId: string): Promise<TemplateVersionView> {
  return apiClient.post<TemplateVersionView>(`${BASE}/${encodeURIComponent(templateId)}/draft`, {});
}

// Save DRAFT content (DRAFT-only; re-arms the §18 preview gate server-side).
export async function updateDraftVersion(
  versionId: string,
  input: { field_schema: unknown; render_schema_version?: string },
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
