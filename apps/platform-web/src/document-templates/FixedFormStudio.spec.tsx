import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdentityProvider } from '../identity/identity';
import { platformSession } from '../skills/test-session';

import { documentTemplatesApi, type PlatformTemplateDetail } from './document-templates-api';
import { DocumentTemplateDetailView } from './DocumentTemplateDetailView';
import { fixedFormsApi } from './fixed-forms-api';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.2 — a default of a FIXED_FORM
// document type opens the Studio's fixed-form mode (official PDF + fields by role), wired to the
// platform fixed-form routes; an EDITABLE default keeps the Template Studio.

const DETAIL: PlatformTemplateDetail = {
  id: 'f1',
  owner_scope: 'PLATFORM',
  document_type_id: 'type-i9',
  name: 'Form I-9',
  description: null,
  template_kind: 'UPLOADED_PDF',
  status: 'DRAFT',
  products: ['sign'],
  current_version: null,
  draft_version_id: 'v1',
  withdraw_notice_at: null,
  withdraw_effective_at: null,
  created_at: '2026-11-02T00:00:00.000Z',
  updated_at: '2026-11-02T00:00:00.000Z',
  versions: [],
};

describe('DocumentTemplateDetailView → fixed-form mode (§7.2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens the fixed-form Studio for a FIXED_FORM type and loads the draft through the fixed-form routes', async () => {
    vi.spyOn(documentTemplatesApi, 'getTemplate').mockResolvedValue(DETAIL);
    vi.spyOn(documentTemplatesApi, 'listDocumentTypes').mockResolvedValue({
      document_types: [{ id: 'type-i9', key: 'I9', name: 'Form I-9', configurable: false, template_kind: 'FIXED_FORM', products: ['sign'], category: 'Employment' }],
    });
    const view = vi.spyOn(fixedFormsApi, 'view').mockResolvedValue({
      template_id: 'f1',
      version_id: 'v1',
      version_number: 1,
      status: 'DRAFT',
      content: { render_schema_version: 'fixed-form-pdf-v1', title: 'Form I-9', pdf: null, signing: { roles: [{ role_key: 'signer', label: 'Signer', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' } },
      fields: [],
      variables: [],
      issues: [{ code: 'pdf_required', message: 'Upload the official PDF.' }],
      previewed: false,
    });
    const session = platformSession(['platform:tenant:read', 'platform:document_template:read', 'platform:document_template:manage']);
    render(
      <MemoryRouter initialEntries={['/document-templates/f1']}>
        <IdentityProvider session={session} load={() => Promise.reject(new Error('x'))}>
          <Routes>
            <Route path="/document-templates/:id" element={<DocumentTemplateDetailView session={session} />} />
          </Routes>
        </IdentityProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('fixed-form-studio')).toBeInTheDocument();
    expect(await screen.findByText('Upload the official PDF.')).toBeInTheDocument();
    expect(view).toHaveBeenCalledWith('v1');
    expect(screen.getByRole('button', { name: 'Upload PDF…' })).toBeInTheDocument();
    expect(screen.getByText(/Fixed form · v1 · Draft/)).toBeInTheDocument();
  });
});
