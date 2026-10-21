import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformSession } from '../skills/test-session';

import { documentTemplatesApi, type PlatformTemplate } from './document-templates-api';
import { DocumentTemplatesListView } from './DocumentTemplatesListView';

const READ = ['platform:document_template:read'];
const MANAGE = ['platform:document_template:read', 'platform:document_template:manage'];

const TEMPLATES: PlatformTemplate[] = [
  {
    id: 't1',
    owner_scope: 'PLATFORM',
    document_type_id: 'd1',
    name: 'Aramo standard RTR',
    description: null,
    template_kind: 'GENERATED',
    status: 'ACTIVE',
    products: ['ATS', 'SIGN'],
    current_version: { id: 'v2', version_number: 2, status: 'ACTIVE', activated_at: '2026-10-20T10:00:00.000Z' },
    draft_version_id: null,
    withdraw_notice_at: null,
    withdraw_effective_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-21T00:00:00.000Z',
  },
  {
    id: 't2',
    owner_scope: 'PLATFORM',
    document_type_id: 'd1',
    name: 'Mutual NDA',
    description: null,
    template_kind: 'GENERATED',
    status: 'DRAFT',
    products: [],
    current_version: null,
    draft_version_id: 'v9',
    withdraw_notice_at: null,
    withdraw_effective_at: null,
    created_at: '2026-10-02T00:00:00.000Z',
    updated_at: '2026-10-03T00:00:00.000Z',
  },
];

function renderView(scopes: string[]) {
  return render(
    <MemoryRouter>
      <DocumentTemplatesListView session={platformSession(scopes)} />
    </MemoryRouter>,
  );
}

describe('DocumentTemplatesListView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists Aramo defaults with current version, Updated date (publish date) and product tags', async () => {
    vi.spyOn(documentTemplatesApi, 'listTemplates').mockResolvedValue({ templates: TEMPLATES });
    renderView(READ);
    expect(await screen.findByText('Aramo standard RTR')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('2026-10-20')).toBeInTheDocument();
    expect(screen.getByText('ATS')).toBeInTheDocument();
    expect(screen.getByText('SIGN')).toBeInTheDocument();
    // An unpublished default shows its last change and its open draft.
    expect(screen.getByText('Not published')).toBeInTheDocument();
    expect(screen.getByText('2026-10-03')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('read-only scope: no Create control', async () => {
    vi.spyOn(documentTemplatesApi, 'listTemplates').mockResolvedValue({ templates: TEMPLATES });
    renderView(READ);
    await screen.findByText('Aramo standard RTR');
    expect(screen.queryByRole('button', { name: 'Create default template' })).not.toBeInTheDocument();
  });

  it('manage scope: Create opens the dialog and posts a PLATFORM template with parsed product tags', async () => {
    vi.spyOn(documentTemplatesApi, 'listTemplates').mockResolvedValue({ templates: [] });
    vi.spyOn(documentTemplatesApi, 'listDocumentTypes').mockResolvedValue({
      document_types: [{ id: 'd1', key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent', configurable: true }],
    });
    const create = vi.spyOn(documentTemplatesApi, 'createTemplate').mockResolvedValue({ ...TEMPLATES[1]!, id: 'new' });
    renderView(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Create default template' }));
    await screen.findByRole('option', { name: 'Right to Represent' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Aramo RTR' } });
    fireEvent.change(screen.getByLabelText('Products'), { target: { value: 'ats, sign ats' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        document_type_id: 'd1',
        name: 'Aramo RTR',
        description: null,
        template_kind: 'GENERATED',
        products: ['ATS', 'SIGN'],
      }),
    );
  });
});
