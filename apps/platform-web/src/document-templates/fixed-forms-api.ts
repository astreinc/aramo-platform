import { apiClient } from '@aramo/fe-foundation';
import type { FixedFormField, FixedFormFieldSuggestions, FixedFormRole, FixedFormVersionView } from '@aramo/document-templates-web';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.1, §7.2 — typed client for the
// fixed-form authoring routes of an Aramo default of a FIXED_FORM document type
// (/platform/document-templates/*/fixed-form*, /platform/document-templates/versions/:id/fields).
// Publish / withdraw / discard / tags reuse documentTemplatesApi (the shared default routes).

const BASE = '/platform/document-templates';

export const fixedFormsApi = {
  createDraft(templateId: string): Promise<FixedFormVersionView> {
    return apiClient.post(`${BASE}/${templateId}/fixed-form/draft`);
  },
  view(versionId: string): Promise<FixedFormVersionView> {
    return apiClient.get(`${BASE}/versions/${versionId}/fixed-form`);
  },
  pdf(versionId: string): Promise<{ sha256: string; byte_size: number; content_base64: string }> {
    return apiClient.get(`${BASE}/versions/${versionId}/fixed-form/pdf`);
  },
  // FIELD-PARITY-1 P2-5 / P2-6 — `options` holds only the ticked flags (import_fields /
  // apply_text_tags); without them the body is exactly { content_base64 }.
  uploadPdf(versionId: string, content_base64: string, options: { import_fields?: true; apply_text_tags?: true } = {}): Promise<FixedFormVersionView> {
    return apiClient.put(`${BASE}/versions/${versionId}/fixed-form/pdf`, { content_base64, ...options });
  },
  // FIELD-PARITY-1 P2-4 — the deterministic detector's suggestions for the version's PDF.
  fieldSuggestions(versionId: string): Promise<FixedFormFieldSuggestions> {
    return apiClient.get(`${BASE}/versions/${versionId}/fixed-form/field-suggestions`);
  },
  saveLayout(
    versionId: string,
    body: { signing: { roles: readonly FixedFormRole[]; routing_mode: 'PARALLEL' | 'SEQUENTIAL' }; fields: readonly FixedFormField[] },
  ): Promise<FixedFormVersionView> {
    return apiClient.put(`${BASE}/versions/${versionId}/fixed-form/layout`, body);
  },
  preview(versionId: string): Promise<FixedFormVersionView> {
    return apiClient.post(`${BASE}/versions/${versionId}/fixed-form/preview`);
  },
};
