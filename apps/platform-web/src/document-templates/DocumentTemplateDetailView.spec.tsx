import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformSession } from '../skills/test-session';

import { documentTemplatesApi, type PlatformTemplateDetail, type TemplateVersion } from './document-templates-api';
import { DocumentTemplateDetailView } from './DocumentTemplateDetailView';

const MANAGE = ['platform:document_template:read', 'platform:document_template:manage'];

const DRAFT: TemplateVersion = {
  id: 'v1',
  template_id: 't1',
  version_number: 1,
  status: 'DRAFT',
  render_schema_version: 'rtr-html-v1',
  field_schema: { render_schema_version: 'rtr-html-v1', title: 'Right to Represent', html: '<p>Hi <span data-field="talent.full_name"></span></p>' },
  activated_at: null,
  created_at: '2026-10-21T00:00:00.000Z',
  content_fingerprint: 'a',
  previewed_fingerprint: null,
  internal_notes: null,
};

const DETAIL: PlatformTemplateDetail = {
  id: 't1',
  owner_scope: 'PLATFORM',
  document_type_id: 'd1',
  name: 'Aramo standard RTR',
  description: null,
  template_kind: 'GENERATED',
  status: 'DRAFT',
  products: ['ATS'],
  current_version: null,
  draft_version_id: 'v1',
  withdraw_notice_at: null,
  withdraw_effective_at: null,
  created_at: '2026-10-21T00:00:00.000Z',
  updated_at: '2026-10-21T00:00:00.000Z',
  versions: [DRAFT],
};

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/document-templates/t1']}>
      <Routes>
        <Route path="/document-templates/:id" element={<DocumentTemplateDetailView session={platformSession(MANAGE)} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DocumentTemplateDetailView — draft editor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders variables as catalog-labelled chips; Publish stays disabled until the draft is previewed', async () => {
    vi.spyOn(documentTemplatesApi, 'getTemplate').mockResolvedValue(DETAIL);
    vi.spyOn(documentTemplatesApi, 'allowedBindings').mockResolvedValue({ bindings: [{ key: 'talent.full_name', label: 'Talent full name', group: 'Talent' }] });
    const preview = vi.spyOn(documentTemplatesApi, 'preview').mockResolvedValue({
      title: 'Right to Represent',
      blocks: [],
      html: '<p>Hi <span data-sample="talent.full_name">Ravi Shankar</span></p>',
    });
    const publish = vi.spyOn(documentTemplatesApi, 'publish').mockResolvedValue({ ...DRAFT, status: 'ACTIVE' });
    renderView();
    expect(await screen.findByText('Talent full name')).toBeInTheDocument();
    const publishBtn = screen.getByRole('button', { name: 'Publish' });
    expect(publishBtn).toBeDisabled();
    expect(screen.getByText('Preview the current draft before publishing it.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Ravi Shankar')).toBeInTheDocument();
    expect(preview).toHaveBeenCalledWith('v1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith('v1'));
  });

  it('Insert variable adds a catalog field node; editing re-disables Publish and Preview saves first', async () => {
    vi.spyOn(documentTemplatesApi, 'getTemplate').mockResolvedValue({ ...DETAIL, versions: [{ ...DRAFT, previewed_fingerprint: 'a' }] });
    vi.spyOn(documentTemplatesApi, 'allowedBindings').mockResolvedValue({
      bindings: [
        { key: 'talent.full_name', label: 'Talent full name', group: 'Talent' },
        { key: 'client.name', label: 'Client name', group: 'Client' },
      ],
    });
    const update = vi.spyOn(documentTemplatesApi, 'updateDraft').mockResolvedValue(DRAFT);
    vi.spyOn(documentTemplatesApi, 'preview').mockResolvedValue({ title: 'T', blocks: [], html: '<p>x</p>' });
    renderView();
    await screen.findByText('Talent full name');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Variable'), { target: { value: 'client.name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert variable' }));
    expect((screen.getByLabelText('Content') as HTMLTextAreaElement).value).toContain('<span data-field="client.name"></span>');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toMatchObject({ render_schema_version: 'rtr-html-v1' });
  });
});
