import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { DocumentTemplateView, TemplateVersionView } from '../document-templates-api';
import { TEMPLATE_SYNC_COPY, templateMasterBadge, templatesWithNewerMaster, type TemplateMaster } from '../template-sync';

import { organizationStudioDataSource, type OrganizationStudioApi } from './organization-source';
import { TemplateStudio } from './TemplateStudio';

// TEMPLATE-SYNC-1 (Directive v1.0 LOCKED) S-6 / S-9 / S-12 and §5 test 4 — the shared Studio's
// "a newer master is available" notice (organization source): Compare, Start a draft from the
// new version and Keep my version for an approver; Compare and Start a draft for an author; no
// actions for a read-only operator. The words are the one shared set.

const scoped = (scopes: string[]) => ({ scopes });
const MANAGER = scoped(['document_template:read', 'document_template:author', 'document_template:manage']);
const AUTHOR = scoped(['document_template:read', 'document_template:author']);
const READER = scoped(['document_template:read']);
const OPTS = { organizationHref: '/org/overview', listHref: '/org/document-templates' };

const NEWER: TemplateMaster = {
  template_id: 'm1', name: 'Mutual NDA', current_version_id: 'mv2', current_version_number: 2, based_on_version_number: 1, newer_available: true, withdrawn: null, kept: false,
};

function tpl(master: TemplateMaster | null): DocumentTemplateView {
  return {
    id: 't1', tenant_id: 'x', document_type_id: 'rtr', client_id: null, name: 'Our NDA', description: null, template_kind: 'GENERATED',
    status: 'ACTIVE', current_version_id: 'v1', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z',
    adopted_from_template_id: 'm1', master,
  };
}
function ver(id: string, n: number, status: TemplateVersionView['status'], html: string): TemplateVersionView {
  return {
    id, tenant_id: 'x', template_id: 't1', version_number: n, status, render_schema_version: 'rtr-html-v2',
    field_schema: { render_schema_version: 'rtr-html-v2', title: 'Our NDA', html }, binding_schema: null,
    created_by: 'u', created_at: '2026-10-01T00:00:00.000Z', activated_at: '2026-10-01T00:00:00.000Z', activated_by: null, retired_at: null,
    content_fingerprint: null, previewed_fingerprint: null,
  };
}
function api(master: TemplateMaster | null, over: Partial<OrganizationStudioApi> = {}): Partial<OrganizationStudioApi> {
  return {
    getTemplate: vi.fn().mockResolvedValue(tpl(master)),
    listVersions: vi.fn().mockResolvedValue([ver('v1', 1, 'ACTIVE', '<p>Our wording</p>')]),
    catalog: vi.fn().mockResolvedValue({ bindings: [], tenantLogo: null }),
    library: vi.fn().mockResolvedValue({ items: [], document_types: [{ id: 'rtr', key: 'NDA', name: 'NDA', configurable: true }] }),
    masterContent: vi.fn().mockResolvedValue({
      template_id: 't1', master_template_id: 'm1', version_id: 'mv2', version_number: 2, render_schema_version: 'rtr-html-v2', title: 'Mutual NDA', html: '<p>Master wording</p>', signing: null,
    }),
    draftFromMaster: vi.fn().mockResolvedValue(ver('d2', 2, 'DRAFT', '<p>Master wording</p>')),
    keepVersion: vi.fn().mockResolvedValue(tpl({ ...NEWER, kept: true, newer_available: false })),
    ...over,
  };
}

function renderStudio(session: { scopes: string[] }, a: Partial<OrganizationStudioApi>) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  const ds = organizationStudioDataSource({ session, ...OPTS, api: a });
  render(
    <MemoryRouter>
      <TemplateStudio context="organization" dataSource={ds} templateId="t1" />
    </MemoryRouter>,
  );
}

describe('TEMPLATE-SYNC-1 — the shared words and the server flag', () => {
  it('badges come from the server flags only; the banner counts newer_available', () => {
    expect(templateMasterBadge(NEWER)).toBe('Newer version available');
    expect(templateMasterBadge({ ...NEWER, newer_available: false, withdrawn: { notice_at: 'x', effective_at: 'y', status: 'PENDING' } })).toBe('Withdrawn by Aramo');
    expect(templateMasterBadge({ ...NEWER, newer_available: false, kept: true })).toBeNull();
    expect(templateMasterBadge(null)).toBeNull();
    expect(templatesWithNewerMaster([{ master: NEWER }, { master: null }, { master: { ...NEWER, newer_available: false } }, {}])).toBe(1);
    expect(TEMPLATE_SYNC_COPY.banner(1)).toBe('Aramo updated 1 template you use');
    expect(TEMPLATE_SYNC_COPY.banner(3)).toBe('Aramo updated 3 templates you use');
  });
});

describe('TEMPLATE-SYNC-1 — the Studio notice (organization source)', () => {
  it('an approver sees Compare, Start a draft and Keep my version', async () => {
    renderStudio(MANAGER, api(NEWER));
    const notice = await screen.findByTestId('studio-master-notice');
    expect(notice).toHaveTextContent('Aramo published version 2 of Mutual NDA. Your template is based on version 1.');
    expect(screen.getByTestId('studio-master-compare')).toHaveTextContent(TEMPLATE_SYNC_COPY.compare);
    expect(screen.getByTestId('studio-master-start')).toHaveTextContent(TEMPLATE_SYNC_COPY.startDraft);
    expect(screen.getByTestId('studio-master-keep')).toHaveTextContent(TEMPLATE_SYNC_COPY.keep);
  });

  it('an author sees Compare and Start a draft, not Keep my version', async () => {
    renderStudio(AUTHOR, api(NEWER));
    await screen.findByTestId('studio-master-notice');
    expect(screen.getByTestId('studio-master-compare')).toBeInTheDocument();
    expect(screen.getByTestId('studio-master-start')).toBeInTheDocument();
    expect(screen.queryByTestId('studio-master-keep')).toBeNull();
  });

  it('a read-only operator sees the notice with no actions', async () => {
    renderStudio(READER, api(NEWER));
    await screen.findByTestId('studio-master-notice');
    expect(screen.queryByTestId('studio-master-compare')).toBeNull();
    expect(screen.queryByTestId('studio-master-start')).toBeNull();
    expect(screen.queryByTestId('studio-master-keep')).toBeNull();
  });

  it('no notice when nothing is newer (kept for this master version)', async () => {
    const a = api({ ...NEWER, newer_available: false, kept: true });
    renderStudio(MANAGER, a);
    await screen.findByRole('banner');
    await waitFor(() => expect(a.listVersions).toHaveBeenCalled());
    expect(screen.queryByTestId('studio-master-notice')).toBeNull();
  });

  it('withdrawn: the notice says so and offers no update', async () => {
    renderStudio(MANAGER, api({ ...NEWER, newer_available: false, withdrawn: { notice_at: '2026-11-01T00:00:00Z', effective_at: '2026-12-01T00:00:00Z', status: 'PENDING' } }));
    const notice = await screen.findByTestId('studio-master-notice');
    expect(notice).toHaveTextContent('Aramo is withdrawing Mutual NDA');
    expect(screen.queryByTestId('studio-master-start')).toBeNull();
  });

  it('Compare opens the 2-way compare with the Aramo version as a side', async () => {
    const a = api(NEWER);
    renderStudio(MANAGER, a);
    fireEvent.click(await screen.findByTestId('studio-master-compare'));
    await waitFor(() => expect(a.masterContent).toHaveBeenCalledWith('t1'));
    expect(await screen.findByRole('dialog', { name: 'Compare versions' })).toBeInTheDocument();
    expect(screen.getAllByText(/Aramo v2/).length).toBeGreaterThan(0);
  });

  it('Start a draft from the new version calls the server and reloads; Keep my version calls keep', async () => {
    const a = api(NEWER);
    renderStudio(MANAGER, a);
    fireEvent.click(await screen.findByTestId('studio-master-start'));
    await waitFor(() => expect(a.draftFromMaster).toHaveBeenCalledWith('t1'));
    fireEvent.click(screen.getByTestId('studio-master-keep'));
    await waitFor(() => expect(a.keepVersion).toHaveBeenCalledWith('t1'));
  });

  it('a refusal is shown in the notice', async () => {
    const a = api(NEWER, { draftFromMaster: vi.fn().mockRejectedValue(new Error('This template already has a draft.')) });
    renderStudio(MANAGER, a);
    fireEvent.click(await screen.findByTestId('studio-master-start'));
    expect(await screen.findByTestId('studio-master-error')).toHaveTextContent('This template already has a draft.');
  });
});
