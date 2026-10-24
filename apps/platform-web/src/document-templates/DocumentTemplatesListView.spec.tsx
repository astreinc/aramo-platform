import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformSession } from '../skills/test-session';

import { documentTemplatesApi, type DocumentTypeOption, type PlatformTemplate, type TemplateVersion } from './document-templates-api';
import { DocumentTemplatesListView } from './DocumentTemplatesListView';

// PLATFORM-UX-1 F-9 (handoff §10.1; directive R-10) — the template library: product
// filter + search, the §10.1 columns, the view-only note, and Create (blank / copy of a
// published template of the same document type, with the partial-failure landing).

const READ = ['platform:document_template:read'];
const MANAGE = ['platform:document_template:read', 'platform:document_template:manage'];

const TYPES: DocumentTypeOption[] = [
  { id: 'd1', key: 'rtr', name: 'Right to represent', configurable: true },
  { id: 'd2', key: 'tax', name: 'Tax form', configurable: false },
];

function tpl(id: string, name: string, extra: Partial<PlatformTemplate> = {}): PlatformTemplate {
  return {
    id,
    owner_scope: 'PLATFORM',
    document_type_id: 'd1',
    name,
    description: null,
    template_kind: 'GENERATED',
    status: 'ACTIVE',
    products: ['ATS'],
    current_version: null,
    draft_version_id: null,
    withdraw_notice_at: null,
    withdraw_effective_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-21T00:00:00.000Z',
    ...extra,
  };
}

const TEMPLATES: PlatformTemplate[] = [
  tpl('t1', 'Aramo standard RTR', {
    products: ['ATS', 'SIGN'],
    current_version: { id: 'v2', version_number: 2, status: 'ACTIVE', activated_at: '2026-10-20T10:00:00.000Z' },
    withdraw_notice_at: '2026-10-20T00:00:00.000Z',
    withdraw_effective_at: '2099-10-29T00:00:00.000Z',
  }),
  tpl('t2', 'Mutual NDA', { status: 'DRAFT', products: ['SIGN'], draft_version_id: 'v9' }),
];

function Where() {
  const loc = useLocation();
  return (
    <div>
      <span data-testid="path">{loc.pathname}</span>
      <span data-testid="state">{JSON.stringify(loc.state)}</span>
    </div>
  );
}

function renderView(scopes: string[]) {
  vi.spyOn(documentTemplatesApi, 'listTemplates').mockResolvedValue({ templates: TEMPLATES });
  vi.spyOn(documentTemplatesApi, 'listDocumentTypes').mockResolvedValue({ document_types: TYPES });
  return render(
    <MemoryRouter initialEntries={['/document-templates']}>
      <Routes>
        <Route path="/document-templates" element={<DocumentTemplatesListView session={platformSession(scopes)} />} />
        <Route path="/document-templates/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

function version(field_schema: unknown): TemplateVersion {
  return {
    id: 'v2',
    template_id: 't1',
    version_number: 2,
    status: 'ACTIVE',
    render_schema_version: 'rtr-html-v1',
    field_schema,
    activated_at: null,
    created_at: '',
    content_fingerprint: null,
    previewed_fingerprint: null,
    internal_notes: null,
  };
}

describe('DocumentTemplatesListView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists templates with type · id, the version and withdrawal pills, draft, products and Open studio', async () => {
    renderView(MANAGE);
    expect(await screen.findByText('Aramo standard RTR')).toBeInTheDocument();
    const row = screen.getByText('Aramo standard RTR').closest('tr') as HTMLElement;
    expect(within(row).getByText('Right to represent', { exact: false })).toBeInTheDocument();
    expect(within(row).getByText('t1')).toBeInTheDocument();
    expect(within(row).getByText('Published v2')).toBeInTheDocument();
    expect(within(row).getByText('Withdrawal 29 Oct 2099')).toBeInTheDocument();
    expect(within(row).getByText('No draft')).toBeInTheDocument();
    expect(within(row).getByText('SIGN')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Open studio for Aramo standard RTR' })).toHaveAttribute('href', '/document-templates/t1');
    const nda = screen.getByText('Mutual NDA').closest('tr') as HTMLElement;
    expect(within(nda).getByText('Not published')).toBeInTheDocument();
    expect(within(nda).getByText('Open draft')).toBeInTheDocument();
    expect(screen.getByText('2 templates')).toBeInTheDocument();
  });

  it('filters by product and search; an empty result shows the designed empty state', async () => {
    renderView(MANAGE);
    await screen.findByText('Mutual NDA');
    fireEvent.click(screen.getByRole('button', { name: 'ATS' }));
    expect(screen.queryByText('Mutual NDA')).toBeNull();
    expect(screen.getByText('1 templates')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All products' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search templates' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No templates match')).toBeInTheDocument();
  });

  it('a row click opens the Studio', async () => {
    renderView(READ);
    fireEvent.click(await screen.findByText('Mutual NDA'));
    expect(screen.getByTestId('path')).toHaveTextContent('/document-templates/t2');
  });

  it('read-only operators get the view-only note and no Create', async () => {
    renderView(READ);
    await screen.findByText('Mutual NDA');
    expect(screen.queryByRole('button', { name: '+ Create default template' })).toBeNull();
    expect(screen.getByText('View only.')).toBeInTheDocument();
    expect(screen.getByText('Manage templates')).toBeInTheDocument();
  });

  it('Create (blank): non-configurable types are disabled with the reason; creates and opens the Studio', async () => {
    const create = vi.spyOn(documentTemplatesApi, 'createTemplate').mockResolvedValue(tpl('t9', 'New RTR'));
    const draft = vi.spyOn(documentTemplatesApi, 'createDraft');
    renderView(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: '+ Create default template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create default template' });
    expect(within(dialog).getByRole('option', { name: 'Tax form — not configurable here' })).toBeDisabled();
    const commit = within(dialog).getByRole('button', { name: 'Create and open studio' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Document type/ }), { target: { value: 'd1' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Name/ }), { target: { value: 'New RTR' } });
    expect(within(dialog).getByText('7 / 120')).toBeInTheDocument();
    fireEvent.click(commit);
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ document_type_id: 'd1', name: 'New RTR', description: null, template_kind: 'GENERATED', products: ['ATS'] }),
    );
    expect(draft).not.toHaveBeenCalled();
    expect(await screen.findByTestId('path')).toHaveTextContent('/document-templates/t9');
  });

  it('Create (copy): offers only published templates of the same type; reads the version, creates, then drafts the copy', async () => {
    const order: string[] = [];
    const fs = { render_schema_version: 'rtr-html-v1', title: 'RTR', html: '<p>Hi</p>' };
    vi.spyOn(documentTemplatesApi, 'getVersion').mockImplementation(async () => {
      order.push('getVersion');
      return version(fs);
    });
    vi.spyOn(documentTemplatesApi, 'createTemplate').mockImplementation(async () => {
      order.push('createTemplate');
      return tpl('t9', 'Copy');
    });
    const draft = vi.spyOn(documentTemplatesApi, 'createDraft').mockImplementation(async () => {
      order.push('createDraft');
      return version(fs);
    });
    renderView(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: '+ Create default template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create default template' });
    const start = within(dialog).getByRole('combobox', { name: 'Start from' });
    expect(within(start).getAllByRole('option')).toHaveLength(1); // no type chosen yet
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Document type/ }), { target: { value: 'd1' } });
    // Only the PUBLISHED d1 template (the NDA draft is unpublished).
    expect(within(start).getAllByRole('option').map((o) => o.textContent)).toEqual(['Blank document', 'Copy of Aramo standard RTR (v2)']);
    fireEvent.change(start, { target: { value: 'copy:t1' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Name/ }), { target: { value: 'Copy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create and open studio' }));
    await waitFor(() => expect(draft).toHaveBeenCalledWith('t9', { render_schema_version: 'rtr-html-v1', field_schema: fs }));
    expect(order).toEqual(['getVersion', 'createTemplate', 'createDraft']);
    expect(await screen.findByTestId('path')).toHaveTextContent('/document-templates/t9');
    expect(screen.getByTestId('state')).toHaveTextContent('null');
  });

  it('Create (copy) partial failure: lands in the Studio with the inline error', async () => {
    vi.spyOn(documentTemplatesApi, 'getVersion').mockResolvedValue(version({ render_schema_version: 'rtr-html-v1', title: 'x', html: '' }));
    vi.spyOn(documentTemplatesApi, 'createTemplate').mockResolvedValue(tpl('t9', 'Copy'));
    vi.spyOn(documentTemplatesApi, 'createDraft').mockRejectedValue(new Error('boom'));
    renderView(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: '+ Create default template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create default template' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Document type/ }), { target: { value: 'd1' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Start from' }), { target: { value: 'copy:t1' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Name/ }), { target: { value: 'Copy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create and open studio' }));
    expect(await screen.findByTestId('path')).toHaveTextContent('/document-templates/t9');
    expect(screen.getByTestId('state')).toHaveTextContent('copying Aramo standard RTR into its draft failed');
  });

  it('Create (copy) refuses before creating anything when the source version cannot be read', async () => {
    vi.spyOn(documentTemplatesApi, 'getVersion').mockRejectedValue(new Error('gone'));
    const create = vi.spyOn(documentTemplatesApi, 'createTemplate');
    renderView(MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: '+ Create default template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create default template' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Document type/ }), { target: { value: 'd1' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Start from' }), { target: { value: 'copy:t1' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Name/ }), { target: { value: 'Copy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create and open studio' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not read the published version to copy.');
    expect(create).not.toHaveBeenCalled();
  });
});
