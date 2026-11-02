import { apiClient } from '@aramo/fe-foundation';
import type { TemplateProductKey } from '@aramo/document-templates-web';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §4.3 — typed client for the
// Platform Admin document types (/platform/document-types*). Edge-routed to apps/api (vite
// proxy / nginx), on the shared platform session cookie. Reads need
// platform:document_template:read, writes :manage; the server is authoritative.

export type DocumentTypeClass = 'TEMPLATE' | 'UPLOAD';
export type DocumentTypeKind = 'EDITABLE' | 'FIXED_FORM';
export type DocumentTypeBadge = 'SYSTEM' | 'SEEDED' | null;

export interface PlatformDocumentType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type_class: DocumentTypeClass;
  template_kind: DocumentTypeKind | null;
  products: TemplateProductKey[];
  category: string | null;
  retention_class: string;
  execution_mode_default: string;
  active: boolean;
  system_defined: boolean;
  badge: DocumentTypeBadge;
  /** The fields this screen may change (§4.2); empty for an UPLOAD type. */
  editable_fields: string[];
  templates_count: number;
  live_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface DocumentTypeListResponse {
  document_types: PlatformDocumentType[];
  retention_classes: string[];
  execution_modes: string[];
}

export interface DocumentTypeFields {
  name: string;
  description: string | null;
  category: string | null;
  template_kind: DocumentTypeKind;
  products: TemplateProductKey[];
  retention_class: string;
  execution_mode_default: string;
}

export const DOCUMENT_TYPE_KIND_LABELS: Readonly<Record<DocumentTypeKind, string>> = {
  EDITABLE: 'Editable',
  FIXED_FORM: 'Fixed form',
};

export const EXECUTION_MODE_LABELS: Readonly<Record<string, string>> = {
  NO_SIGNATURE: 'No signature',
  ACKNOWLEDGEMENT: 'Acknowledgement',
  SINGLE_SIGNATURE: 'One signer',
  MULTI_SIGNATURE: 'Several signers',
};

export const documentTypesApi = {
  list(): Promise<DocumentTypeListResponse> {
    return apiClient.get('/platform/document-types');
  },
  create(body: DocumentTypeFields): Promise<PlatformDocumentType> {
    return apiClient.post('/platform/document-types', body);
  },
  update(id: string, body: Partial<DocumentTypeFields>): Promise<PlatformDocumentType> {
    return apiClient.patch(`/platform/document-types/${id}`, body);
  },
  retire(id: string): Promise<PlatformDocumentType> {
    return apiClient.post(`/platform/document-types/${id}/retire`);
  },
  remove(id: string): Promise<void> {
    return apiClient.delete(`/platform/document-types/${id}`);
  },
};
