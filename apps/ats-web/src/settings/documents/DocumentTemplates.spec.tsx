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
  type TemplateVersionView,
} from './document-templates-api';

// DOC-TEMPLATE-ADMIN-RTR-1 (§6/§7/§59) — the tenant document-template admin FE.
// Proves: the catalog lists RTR as the ONLY configurable type (others honest "Not
// configurable yet"); RBAC mirrors the server (read gates view, manage gates the
// action); the RTR detail renders the full version history newest-first with the
// current ACTIVE pinned; and the draft action is "Edit draft" when a DRAFT is open.

function makeSession(scopes: readonly string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes: [...scopes], iat: 0, exp: 0 };
}

const READER = makeSession(['document_template:read']);
const MANAGER = makeSession(['document_template:read', 'document_template:manage']);

function renderAt(path: string, node: ReactElement) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/settings/document-templates" element={node} />
          <Route
            path="/admin/settings/document-templates/rtr"
            element={<div data-testid="rtr-detail-landing" />}
          />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const RTR_TEMPLATE: DocumentTemplateView = {
  id: 'tpl-rtr',
  tenant_id: 't1',
  document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
  client_id: null,
  name: 'Right to Represent',
  description: null,
  template_kind: 'GENERATED',
  status: 'ACTIVE',
  current_version_id: 'v2',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

function version(id: string, n: number, status: TemplateVersionView['status']): TemplateVersionView {
  return {
    id,
    tenant_id: 't1',
    template_id: 'tpl-rtr',
    version_number: n,
    status,
    render_schema_version: 'rtr-generated-v1',
    field_schema: null,
    binding_schema: null,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    activated_at: status === 'ACTIVE' ? '2026-01-02T00:00:00.000Z' : null,
    activated_by: status === 'ACTIVE' ? 'u1' : null,
    retired_at: null,
    content_fingerprint: 'fp',
    previewed_fingerprint: 'fp',
  };
}

describe('DocumentTemplatesSection — catalog (§6)', () => {
  it('lists RTR as configurable and every other governed type as "Not configurable yet"', () => {
    renderAt(
      '/admin/settings/document-templates',
      <DocumentTemplatesSection sessionOverride={MANAGER} />,
    );
    // RTR: a real Manage action.
    const manage = screen.getByTestId('doc-template-manage-RIGHT_TO_REPRESENT');
    expect(manage).toHaveTextContent('Manage');
    expect(manage).not.toBeDisabled();
    // Others: an honest, disabled "Not configurable yet" — never a dead knob.
    expect(screen.queryByTestId('doc-template-manage-OFFER_LETTER')).toBeNull();
    const notYet = screen.getAllByText('Not configurable yet');
    // 4 non-configurable types × (chip + disabled button) — at least the 4 chips.
    expect(notYet.length).toBeGreaterThanOrEqual(4);
  });

  it('a non-reader sees a permission hint and no configurable actions (RBAC mirrors the server)', () => {
    renderAt(
      '/admin/settings/document-templates',
      <DocumentTemplatesSection sessionOverride={makeSession(['talent:read'])} />,
    );
    expect(screen.getByText(/don’t have permission/i)).toBeInTheDocument();
    expect(screen.queryByTestId('doc-template-manage-RIGHT_TO_REPRESENT')).toBeNull();
  });

  it('Manage navigates to the RTR detail', async () => {
    renderAt(
      '/admin/settings/document-templates',
      <DocumentTemplatesSection sessionOverride={MANAGER} />,
    );
    fireEvent.click(screen.getByTestId('doc-template-manage-RIGHT_TO_REPRESENT'));
    expect(await screen.findByTestId('rtr-detail-landing')).toBeInTheDocument();
  });
});

describe('RtrTemplateDetail — detail + version history (§7)', () => {
  const listTemplatesFn = () => Promise.resolve([RTR_TEMPLATE]);

  it('renders the version history newest-first with the current ACTIVE approved', async () => {
    const listVersionsFn = () =>
      Promise.resolve([version('v1', 1, 'RETIRED'), version('v2', 2, 'ACTIVE')]);
    render(
      <ToastProvider>
        <MemoryRouter>
          <RtrTemplateDetail
            sessionOverride={MANAGER}
            listTemplatesFn={listTemplatesFn}
            listVersionsFn={listVersionsFn}
          />
        </MemoryRouter>
      </ToastProvider>,
    );
    const table = await screen.findByTestId('rtr-version-history');
    const rows = within(table).getAllByRole('row').slice(1); // drop the header row
    expect(rows[0]).toHaveTextContent('v2'); // newest first
    expect(rows[1]).toHaveTextContent('v1');
    expect(within(table).getByText('Approved')).toBeInTheDocument();
    expect(within(table).getByText('Retired')).toBeInTheDocument();
  });

  it('shows "Create new draft" when no DRAFT is open and "Edit draft" when one is (one-DRAFT §41)', async () => {
    const { rerender } = render(
      <ToastProvider>
        <MemoryRouter>
          <RtrTemplateDetail
            sessionOverride={MANAGER}
            listTemplatesFn={listTemplatesFn}
            listVersionsFn={() => Promise.resolve([version('v2', 2, 'ACTIVE')])}
          />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByTestId('rtr-detail-draft')).toHaveTextContent('Create new draft');

    rerender(
      <ToastProvider>
        <MemoryRouter>
          <RtrTemplateDetail
            sessionOverride={MANAGER}
            listTemplatesFn={listTemplatesFn}
            listVersionsFn={() =>
              Promise.resolve([version('v2', 2, 'ACTIVE'), version('v3', 3, 'DRAFT')])
            }
          />
        </MemoryRouter>
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('rtr-detail-draft')).toHaveTextContent('Edit draft'),
    );
  });

  it('a manager with no open DRAFT creates one via the API before navigating', async () => {
    const createDraftFn = vi.fn().mockResolvedValue(version('v3', 3, 'DRAFT'));
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/admin/settings/document-templates/rtr']}>
          <Routes>
            <Route
              path="/admin/settings/document-templates/rtr"
              element={
                <RtrTemplateDetail
                  sessionOverride={MANAGER}
                  listTemplatesFn={listTemplatesFn}
                  listVersionsFn={() => Promise.resolve([version('v2', 2, 'ACTIVE')])}
                  createDraftFn={createDraftFn}
                />
              }
            />
            <Route
              path="/admin/settings/document-templates/rtr/draft"
              element={<div data-testid="rtr-draft-landing" />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByTestId('rtr-detail-draft'));
    await waitFor(() => expect(createDraftFn).toHaveBeenCalledWith('tpl-rtr', expect.anything()));
    expect(await screen.findByTestId('rtr-draft-landing')).toBeInTheDocument();
  });

  it('a non-manager reader sees history but no draft action (RBAC)', async () => {
    render(
      <ToastProvider>
        <MemoryRouter>
          <RtrTemplateDetail
            sessionOverride={READER}
            listTemplatesFn={listTemplatesFn}
            listVersionsFn={() => Promise.resolve([version('v2', 2, 'ACTIVE')])}
          />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByTestId('rtr-version-history')).toBeInTheDocument();
    expect(screen.queryByTestId('rtr-detail-draft')).toBeNull();
  });
});
