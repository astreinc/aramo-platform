import type { ReactElement } from 'react';
import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DocumentTemplatesSection } from './DocumentTemplatesSection';
import { RtrTemplateDetail } from './RtrTemplateDetail';
import {
  RIGHT_TO_REPRESENT_TYPE_ID,
  type DocumentTemplateView,
  type TemplateBinding,
  type TemplateVersionView,
} from './document-templates-api';

// DOC-TEMPLATE-ADMIN-RTR-1 (§6/§7/§59) — the tenant document-template admin FE, styled
// to the approved prototype. Proves: the list is a single table with RTR the ONLY
// configurable type (others honest "Not configurable yet"); RBAC mirrors the server; the
// RTR detail renders the version history with Draft/Active/Retired vocabulary (never
// "Approved" as a status) and the one-draft action.

function makeSession(scopes: readonly string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes: [...scopes], iat: 0, exp: 0 };
}
const READER = makeSession(['document_template:read']);
const MANAGER = makeSession(['document_template:read', 'document_template:manage']);

const BINDINGS: readonly TemplateBinding[] = [
  { key: 'talent.full_name', label: 'Talent full name', group: 'Talent' },
  { key: 'client.name', label: 'Client name', group: 'Client' },
];

const RTR_TEMPLATE: DocumentTemplateView = {
  id: 'tpl-rtr', tenant_id: 't1', document_type_id: RIGHT_TO_REPRESENT_TYPE_ID, client_id: null,
  name: 'Standard Right to Represent', description: null, template_kind: 'GENERATED', status: 'ACTIVE',
  current_version_id: 'v2', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
};
function version(id: string, n: number, status: TemplateVersionView['status']): TemplateVersionView {
  return {
    id, tenant_id: 't1', template_id: 'tpl-rtr', version_number: n, status, render_schema_version: 'rtr-generated-v1',
    field_schema: { render_schema_version: 'rtr-generated-v1', title: 'Right to Represent', blocks: [{ type: 'TEXT', text: 'Hi {{talent.full_name}}' }] },
    binding_schema: null, created_by: 'u1', created_at: '2026-01-01T00:00:00.000Z',
    activated_at: status === 'ACTIVE' ? '2026-01-02T00:00:00.000Z' : status === 'RETIRED' ? '2026-01-01T00:00:00.000Z' : null,
    activated_by: status === 'DRAFT' ? null : 'u1', retired_at: null, content_fingerprint: 'fp', previewed_fingerprint: 'fp',
  };
}

function renderList(node: ReactElement) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/admin/settings/document-templates']}>
        <Routes>
          <Route path="/admin/settings/document-templates" element={node} />
          <Route path="/admin/settings/document-templates/rtr" element={<div data-testid="rtr-detail-landing" />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('DocumentTemplatesSection — list table (§6)', () => {
  it('lists RTR as the only configurable type; others are "Not configurable yet" with no action', () => {
    renderList(<DocumentTemplatesSection sessionOverride={MANAGER} />);
    const manage = screen.getByTestId('doc-template-manage-RIGHT_TO_REPRESENT');
    expect(manage).toHaveTextContent('Manage');
    expect(screen.queryByTestId('doc-template-manage-OFFER_LETTER')).toBeNull();
    // 4 non-configurable rows each show the muted "Not configurable yet" pill.
    expect(screen.getAllByText('Not configurable yet').length).toBe(4);
    // No "Configurable" pill exists in the design.
    expect(screen.queryByText('Configurable')).toBeNull();
  });

  it('a non-reader sees the Tenant-Admin-managed notice, not the table', () => {
    renderList(<DocumentTemplatesSection sessionOverride={makeSession(['talent:read'])} />);
    expect(screen.getByText(/managed by your Tenant Admins/i)).toBeInTheDocument();
    expect(screen.queryByTestId('doc-template-manage-RIGHT_TO_REPRESENT')).toBeNull();
  });

  it('uses the Settings section gutter (.set-content)', () => {
    renderList(<DocumentTemplatesSection sessionOverride={MANAGER} />);
    expect(screen.getByTestId('doc-templates-page')).toHaveClass('set-content');
  });

  it('Manage navigates to the RTR detail', async () => {
    renderList(<DocumentTemplatesSection sessionOverride={MANAGER} />);
    fireEvent.click(screen.getByTestId('doc-template-manage-RIGHT_TO_REPRESENT'));
    expect(await screen.findByTestId('rtr-detail-landing')).toBeInTheDocument();
  });
});

describe('RtrTemplateDetail — version history (§7)', () => {
  const base = {
    listTemplatesFn: () => Promise.resolve([RTR_TEMPLATE]),
    listBindingsFn: () => Promise.resolve(BINDINGS),
    resolveNamesFn: () => Promise.resolve({ u1: 'Purush Pichaimuthu' }),
  };

  function renderDetail(props: Parameters<typeof RtrTemplateDetail>[0]) {
    return render(
      <ToastProvider>
        <MemoryRouter><RtrTemplateDetail {...props} /></MemoryRouter>
      </ToastProvider>,
    );
  }

  it('renders the history newest-first with Draft/Active/Retired pills — never "Approved" as a status', async () => {
    renderDetail({ sessionOverride: MANAGER, ...base, listVersionsFn: () => Promise.resolve([version('v1', 1, 'RETIRED'), version('v2', 2, 'ACTIVE')]) });
    const table = await screen.findByTestId('rtr-version-history');
    const rows = within(table).getAllByTestId(/^rtr-version-\d+$/);
    expect(rows[0]).toHaveTextContent('v2');
    expect(within(table).getByText('Active')).toBeInTheDocument();
    expect(within(table).getByText('Retired')).toBeInTheDocument();
    // The status vocabulary is Draft/Active/Retired — the word "Approved" appears only in
    // the row's human date ("Approved Jan 2, 2026"), never as a status pill.
    expect(within(table).queryByText(/^Approved$/)).toBeNull();
  });

  it('shows "Create new version" with no draft and "Continue draft v{n}" when one is open', async () => {
    const { rerender } = renderDetail({ sessionOverride: MANAGER, ...base, listVersionsFn: () => Promise.resolve([version('v2', 2, 'ACTIVE')]) });
    expect(await screen.findByTestId('rtr-detail-draft')).toHaveTextContent('Create new version');
    rerender(
      <ToastProvider>
        <MemoryRouter>
          <RtrTemplateDetail sessionOverride={MANAGER} {...base} listVersionsFn={() => Promise.resolve([version('v2', 2, 'ACTIVE'), version('v3', 3, 'DRAFT')])} />
        </MemoryRouter>
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('rtr-detail-draft')).toHaveTextContent('Continue draft v3'));
  });

  it('a reader (no manage) sees history but no draft action', async () => {
    renderDetail({ sessionOverride: READER, ...base, listVersionsFn: () => Promise.resolve([version('v2', 2, 'ACTIVE')]) });
    expect(await screen.findByTestId('rtr-version-history')).toBeInTheDocument();
    expect(screen.queryByTestId('rtr-detail-draft')).toBeNull();
  });

  it('no-manage draft creation calls the copy API and navigates', async () => {
    const createDraftFn = vi.fn().mockResolvedValue(version('v3', 3, 'DRAFT'));
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/admin/settings/document-templates/rtr']}>
          <Routes>
            <Route path="/admin/settings/document-templates/rtr" element={<RtrTemplateDetail sessionOverride={MANAGER} {...base} listVersionsFn={() => Promise.resolve([version('v2', 2, 'ACTIVE')])} createDraftFn={createDraftFn} />} />
            <Route path="/admin/settings/document-templates/rtr/draft" element={<div data-testid="rtr-draft-landing" />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByTestId('rtr-detail-draft'));
    await waitFor(() => expect(createDraftFn).toHaveBeenCalledWith('tpl-rtr'));
    expect(await screen.findByTestId('rtr-draft-landing')).toBeInTheDocument();
  });

  it('uses the Settings section gutter (.set-content)', async () => {
    renderDetail({ sessionOverride: MANAGER, ...base, listVersionsFn: () => Promise.resolve([version('v2', 2, 'ACTIVE')]) });
    await screen.findByTestId('rtr-version-history');
    expect(screen.getByTestId('rtr-detail-page')).toHaveClass('set-content');
  });

  it('previews a DRAFT through the server render; an ACTIVE version shows its wording with field chips (no invented values)', async () => {
    const previewFn = vi.fn().mockResolvedValue({ title: 'RTR — Sample', blocks: [{ type: 'TEXT', text: 'Hi Server Sample Talent' }] });
    renderDetail({ sessionOverride: MANAGER, ...base, previewFn, listVersionsFn: () => Promise.resolve([version('v2', 2, 'ACTIVE'), version('v3', 3, 'DRAFT')]) });
    const draftRow = await screen.findByTestId('rtr-version-3');
    fireEvent.click(within(draftRow).getByText('Preview'));
    await waitFor(() => expect(previewFn).toHaveBeenCalledWith('v3'));
    expect(await screen.findByTestId('dt-preview-paper')).toHaveTextContent('Hi Server Sample Talent');
    fireEvent.click(screen.getByTestId('dt-preview-close'));

    fireEvent.click(screen.getByTestId('rtr-preview-active'));
    const paper = await screen.findByTestId('dt-preview-paper');
    expect(previewFn).toHaveBeenCalledTimes(1);
    expect(within(paper).getByText('Talent full name')).toHaveClass('dt-chip');
    expect(screen.getByTestId('dt-preview-modal').textContent).not.toMatch(/Ravi Shankar|agreed pay|Talent signature/i);
  });

  it('Discard on the DRAFT row (manage only) confirms and calls DELETE; never offered on ACTIVE/RETIRED', async () => {
    const discardFn = vi.fn().mockResolvedValue(undefined);
    let versions = [version('v1', 1, 'RETIRED'), version('v2', 2, 'ACTIVE'), version('v3', 3, 'DRAFT')];
    const listVersionsFn = vi.fn().mockImplementation(() => Promise.resolve(versions));
    renderDetail({ sessionOverride: MANAGER, ...base, listVersionsFn, discardFn });
    await screen.findByTestId('rtr-version-3');
    expect(screen.getAllByTestId('rtr-detail-discard')).toHaveLength(1);
    expect(within(screen.getByTestId('rtr-version-3')).getByTestId('rtr-detail-discard')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rtr-detail-discard'));
    expect(await screen.findByTestId('dt-discard-modal')).toHaveTextContent('Discard draft v3?');
    versions = versions.filter((v) => v.status !== 'DRAFT');
    fireEvent.click(screen.getByTestId('dt-discard-confirm'));
    await waitFor(() => expect(discardFn).toHaveBeenCalledWith('v3'));
    await waitFor(() => expect(screen.queryByTestId('rtr-version-3')).toBeNull());
    expect(screen.queryByTestId('rtr-detail-discard')).toBeNull();
  });

  it('a reader never sees Discard', async () => {
    renderDetail({ sessionOverride: READER, ...base, listVersionsFn: () => Promise.resolve([version('v2', 2, 'ACTIVE'), version('v3', 3, 'DRAFT')]) });
    await screen.findByTestId('rtr-version-3');
    expect(screen.queryByTestId('rtr-detail-discard')).toBeNull();
  });

  it('Approved content draws the fixed signature block ONLY when the version view carries signature_block', async () => {
    const { unmount } = renderDetail({ sessionOverride: READER, ...base, listVersionsFn: () => Promise.resolve([version('v2', 2, 'ACTIVE')]) });
    await screen.findByTestId('rtr-version-history');
    expect(screen.queryByTestId('rtr-approved-signature')).toBeNull();
    unmount();
    const withSig = { ...version('v2', 2, 'ACTIVE'), signature_block: { printed_name: null } } as TemplateVersionView;
    renderDetail({ sessionOverride: READER, ...base, listVersionsFn: () => Promise.resolve([withSig]) });
    const sig = await screen.findByTestId('rtr-approved-signature');
    expect(sig).toHaveTextContent('PRINTED NAME');
    expect(within(sig).getByText('Talent full name')).toHaveClass('dt-chip');
  });

  it('Approved content renders rtr-html-v1 through the safe renderer: marks, lists, chips, letterhead — no raw markup', async () => {
    const html = '<div data-asset="tenant.logo"></div><p>Hi <b>bold</b> <span data-field="talent.full_name"></span></p><ul><li>One</li></ul><script>bad()</script>';
    const v = {
      ...version('v2', 2, 'ACTIVE'),
      render_schema_version: 'rtr-html-v1',
      field_schema: { render_schema_version: 'rtr-html-v1', title: 'Right to Represent', html },
      logo: { asset_id: 'a1', mime: 'image/png' },
    } as TemplateVersionView;
    renderDetail({
      sessionOverride: READER, ...base, listBindingsFn: undefined,
      catalogFn: () => Promise.resolve({ bindings: BINDINGS, tenantLogo: { available: true, tenant_name: 'Astre Consulting Services Inc' } }),
      listVersionsFn: () => Promise.resolve([v]),
    });
    const doc = await screen.findByTestId('rtr-approved-doc');
    expect(doc.querySelector('b')).toHaveTextContent('bold');
    expect(doc.querySelectorAll('li')).toHaveLength(1);
    expect(within(doc).getByText('Talent full name').closest('.dt-chip')).not.toBeNull();
    expect(doc.querySelector('script')).toBeNull();
    const lh = within(doc).getByTestId('dt-doc-letterhead');
    expect(lh).toHaveTextContent('Astre Consulting Services Inc');
    expect(within(lh).getByRole('img')).toHaveAttribute('src', '/v1/document-templates/versions/v2/logo/content?v=a1');
  });
});
