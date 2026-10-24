import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdentityProvider } from '../identity/identity';
import { platformSession } from '../skills/test-session';

import { documentTemplatesApi, type PlatformTemplateDetail } from './document-templates-api';
import { DocumentTemplateDetailView } from './DocumentTemplateDetailView';

// PLATFORM-UX-1 F-9 (directive R-12) — /document-templates/:id renders the Template Studio
// (it replaces the former detail view at the same path), and a copy partial failure
// (R-10) lands there with the inline error from the router state.

const DETAIL: PlatformTemplateDetail = {
  id: 't9',
  owner_scope: 'PLATFORM',
  document_type_id: 'd1',
  name: 'Copy of RTR',
  description: null,
  template_kind: 'GENERATED',
  status: 'DRAFT',
  products: [],
  current_version: null,
  draft_version_id: null,
  withdraw_notice_at: null,
  withdraw_effective_at: null,
  created_at: '2026-10-24T00:00:00.000Z',
  updated_at: '2026-10-24T00:00:00.000Z',
  versions: [],
};

describe('DocumentTemplateDetailView → Template Studio', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens the Studio on the empty draft with the copy error inline', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true });
    const get = vi.spyOn(documentTemplatesApi, 'getTemplate').mockResolvedValue(DETAIL);
    vi.spyOn(documentTemplatesApi, 'allowedBindings').mockResolvedValue({ bindings: [] });
    vi.spyOn(documentTemplatesApi, 'listVariables').mockResolvedValue({ variables: [] });
    vi.spyOn(documentTemplatesApi, 'listDocumentTypes').mockResolvedValue({ document_types: [] });
    const session = platformSession(['platform:tenant:read', 'platform:document_template:read', 'platform:document_template:manage']);
    render(
      <MemoryRouter initialEntries={[{ pathname: '/document-templates/t9', state: { copyError: 'Copying failed: draft not created.' } }]}>
        <IdentityProvider session={session} load={() => Promise.reject(new Error('x'))}>
          <Routes>
            <Route path="/document-templates/:id" element={<DocumentTemplateDetailView session={session} />} />
          </Routes>
        </IdentityProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Start this template')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('t9');
    expect(screen.getByRole('alert')).toHaveTextContent('Copying failed: draft not created.');
    expect(screen.getByText('Not published')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Copy of RTR');
    // R-13: sections library is the designed empty state.
    expect(screen.getByRole('button', { name: 'Browse sections' })).toBeInTheDocument();
  });
});
