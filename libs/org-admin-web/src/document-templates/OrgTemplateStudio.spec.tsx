import { ToastProvider, type Session } from '@aramo/fe-foundation';
import {
  LETTERHEAD_SAVE_BLOCKED,
  type DocumentTemplateView,
  type OrganizationStudioApi,
  type TemplateLibraryView,
  type TemplateVersionView,
} from '@aramo/document-templates-web';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isOrgStudioPath, orgSectionForPath } from '../sections';

import { DocumentTemplatesRoutes } from './DocumentTemplatesRoutes';
import { OrgTemplateStudio } from './OrgTemplateStudio';

// TEMPLATE-STUDIO-1 S-1 (directive §3, §11) — the shared Template Studio in the
// Organization context: the three role states (read-only · edit · edit + approve), the
// Approve & activate copy, Discard draft, the letterhead block (A1), the Sections set, no
// withdrawal and no product tags; and the routes (:templateId → Studio, /draft redirect).

function makeSession(scopes: readonly string[]): Session {
  return { sub: 'user-1', consumer_type: 'org', tenant_id: 'tenant-abc', scopes: [...scopes], iat: 0, exp: 0 };
}
const MANAGER = makeSession(['document_template:read', 'document_template:author', 'document_template:manage']);
const AUTHOR = makeSession(['document_template:read', 'document_template:author']);
const READER = makeSession(['document_template:read']);

const RTR = 'd0c50005-0000-7000-8000-000000000001';
const LOGO = '<div data-asset="tenant.logo"></div>';
const BODY = '<h2>Authorization</h2><p>I, <span data-field="talent.full_name"></span>, authorize the firm.</p>';

function template(over: Partial<DocumentTemplateView> = {}): DocumentTemplateView {
  return {
    id: 'tpl-1', tenant_id: 'tenant-abc', document_type_id: RTR, client_id: null, name: 'Our RTR', description: null,
    template_kind: 'GENERATED', status: 'ACTIVE', current_version_id: 'v2', created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-20T00:00:00.000Z', ...over,
  };
}
function version(id: string, n: number, status: TemplateVersionView['status'], html: string, over: Partial<TemplateVersionView> = {}): TemplateVersionView {
  return {
    id, tenant_id: 'tenant-abc', template_id: 'tpl-1', version_number: n, status, render_schema_version: 'rtr-html-v1',
    field_schema: { render_schema_version: 'rtr-html-v1', title: 'Right to Represent', html }, binding_schema: null,
    created_by: 'u', created_at: `2026-10-0${n}T00:00:00.000Z`, activated_at: status === 'DRAFT' ? null : `2026-10-0${n}T10:00:00.000Z`,
    activated_by: null, retired_at: null, content_fingerprint: 'fp', previewed_fingerprint: null, logo: null, ...over,
  };
}
const V1 = version('v1', 1, 'RETIRED', BODY);
const V2 = version('v2', 2, 'ACTIVE', BODY);
const DRAFT = version('d3', 3, 'DRAFT', BODY);

const BINDINGS = [
  { key: 'talent.full_name', label: 'Talent full name', group: 'Talent', data_type: 'TEXT', sample_value: 'Ravi Shankar', active: true },
  { key: 'client.name', label: 'Client name', group: 'Client', data_type: 'TEXT', sample_value: 'Mindlance', active: true },
  { key: 'requisition.title', label: 'Requisition title', group: 'Requisition', data_type: 'TEXT', sample_value: 'Business Analyst', active: true },
  { key: 'requisition.reference', label: 'Requisition reference', group: 'Requisition', data_type: 'TEXT', sample_value: 'REQ-1001', active: true },
  { key: 'requisition.description', label: 'Job description', group: 'Requisition', data_type: 'MULTILINE_TEXT', sample_value: 'Analyze.', active: true },
  { key: 'recruiting_company.name', label: 'Recruiting company', group: 'Recruiting organization', data_type: 'TEXT', sample_value: 'Astre', active: true },
  { key: 'recruiter.display_name', label: 'Recruiter name', group: 'Recruiter', data_type: 'TEXT', sample_value: 'Deepika Rao', active: true },
];
const LIBRARY: TemplateLibraryView = {
  items: [],
  document_types: [{ id: RTR, key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent', configurable: true }],
};

function makeApi(versions: TemplateVersionView[], tpl: DocumentTemplateView = template(), logoAvailable = true) {
  const api = {
    getTemplate: vi.fn().mockResolvedValue(tpl),
    listVersions: vi.fn().mockResolvedValue(versions),
    catalog: vi.fn().mockResolvedValue({ bindings: BINDINGS, tenantLogo: { available: logoAvailable, tenant_name: 'Astre Consulting' } }),
    library: vi.fn().mockResolvedValue(LIBRARY),
    createVersion: vi.fn().mockResolvedValue(DRAFT),
    createDraftFromActive: vi.fn().mockResolvedValue(DRAFT),
    updateDraft: vi.fn().mockResolvedValue(DRAFT),
    discardDraft: vi.fn().mockResolvedValue(undefined),
    preview: vi.fn().mockResolvedValue({ title: 'Right to Represent', blocks: [], html: '<h2>Authorization</h2><p>I, <span data-sample="talent.full_name">Ravi Shankar</span>, authorize the firm.</p>', sample_values: [] }),
    activate: vi.fn().mockResolvedValue(version('d3', 3, 'ACTIVE', BODY)),
    rename: vi.fn().mockResolvedValue(tpl),
    captureLogo: vi.fn().mockResolvedValue({ asset_id: 'a1', mime: 'image/png' }),
    removeLogo: vi.fn().mockResolvedValue(undefined),
    logoUrl: vi.fn((v: string, a: string | null) => `/logo/${v}/${a ?? ''}`),
  } satisfies OrganizationStudioApi;
  return api;
}

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderStudio(session: Session, api: ReturnType<typeof makeApi>, organizationHref: string | null = '/org/overview') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/org/document-templates/tpl-1']}>
        <Routes>
          <Route
            path="/org/document-templates/tpl-1"
            element={<OrgTemplateStudio session={session} templateId="tpl-1" organizationHref={organizationHref} admin api={api} />}
          />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('/v1/me')) return okJson({ user: { display_name: 'Olive Owner', email: 'o@acme.test' }, roles: [], tenant: { display_name: 'Acme', status: 'ACTIVE' } });
    return okJson({});
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Org Studio — role states (ORG-UX-1 §4.1; directive §1.6)', () => {
  it('owner / admin (manage): edit + Approve & activate vN…, Organization / Our templates crumbs', async () => {
    renderStudio(MANAGER, makeApi([DRAFT, V2, V1]));
    await screen.findByDisplayValue('Right to Represent');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve & activate v3…' })).toHaveAttribute('aria-disabled', 'true');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Organization' })).toHaveAttribute('href', '/org/overview');
    expect(within(crumbs).getByRole('link', { name: 'Our templates' })).toHaveAttribute('href', '/org/document-templates');
    expect(within(crumbs).getByText('Our RTR')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /1 issue before approval/ })).toBeInTheDocument();
  });

  it('author: edits drafts, never sees Approve', async () => {
    renderStudio(AUTHOR, makeApi([DRAFT, V2, V1]), null);
    await screen.findByDisplayValue('Right to Represent');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    // A template author has no Overview: the Organization crumb is plain text.
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).queryByRole('link', { name: 'Organization' })).toBeNull();
    expect(within(crumbs).getByText('Organization')).toBeInTheDocument();
  });

  it('read-only: Preview of the active version, no Save, no Approve, the view-only bar', async () => {
    renderStudio(READER, makeApi([DRAFT, V2, V1]));
    expect(await screen.findByText(/You're seeing the active version/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
  });
});

describe('Org Studio — organization context differences (directive §3.3)', () => {
  it('no withdraw control, no product tags, no description; name + facts + the Scope card; Variables footnote, no catalog link', async () => {
    renderStudio(MANAGER, makeApi([DRAFT, V2, V1]));
    await screen.findByDisplayValue('Right to Represent');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = screen.getByRole('menu', { name: 'More actions' });
    expect(within(menu).queryByText(/Withdraw/)).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Discard draft…' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));

    expect(screen.getByText(/Fields come from Aramo’s governed catalog/)).toBeInTheDocument();
    expect(screen.queryByText(/Manage template variables/)).toBeNull();
    // B-2 metadata on the Variables cards (type + "e.g.").
    expect(screen.getAllByText('multiline text').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    expect(screen.getByRole('textbox', { name: /Name/ })).toHaveValue('Our RTR');
    expect(screen.queryByText('Description')).toBeNull();
    expect(screen.queryByText('Product tags')).toBeNull();
    expect(screen.queryByText('Withdrawal')).toBeNull();
    expect(screen.getByTestId('studio-scope')).toHaveTextContent(
      'Organization default · used for every RTR your recruiters send from Aramo ATS. Client-specific templates may be supported later.',
    );
    expect(screen.getByText('Right to Represent', { selector: 'dd *, dd' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Checks/ }));
    expect(screen.queryByText('Template is not withdrawn')).toBeNull();
  });

  it('approve: save + preview, then "Approve version v3?" with the RTR consequence, activation and the toast', async () => {
    const api = makeApi([DRAFT, V2, V1]);
    renderStudio(MANAGER, api);
    const title = await screen.findByDisplayValue('Right to Represent');
    fireEvent.change(title, { target: { value: 'Right to Represent (2026)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('article', { name: 'Page 1' });
    expect(api.updateDraft).toHaveBeenCalledTimes(1);
    expect(api.preview).toHaveBeenCalledWith('d3');
    const approve = screen.getByRole('button', { name: 'Approve & activate v3…' });
    expect(approve).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(approve);
    const dialog = await screen.findByRole('dialog', { name: 'Approve version v3?' });
    expect(within(dialog).getByText('v3 becomes the template used for every future RTR. RTRs already sent stay pinned to the version they were sent with.')).toBeInTheDocument();
    expect(within(dialog).getByText('v2 active')).toBeInTheDocument();
    expect(within(dialog).getByText('v3 active')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve & activate v3' }));
    await waitFor(() => expect(api.activate).toHaveBeenCalledWith('d3'));
    expect(await screen.findByText('v3 is active. New RTRs use it from now on.')).toBeInTheDocument();
  });

  it('no open draft + an active version: the first save opens the draft from the active version, then saves the content', async () => {
    const api = makeApi([V2, V1]);
    renderStudio(MANAGER, api);
    const title = await screen.findByDisplayValue('Right to Represent');
    fireEvent.change(title, { target: { value: 'New wording' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
    expect(api.createDraftFromActive).toHaveBeenCalledWith('tpl-1');
    expect(api.createVersion).not.toHaveBeenCalled();
    expect(api.updateDraft.mock.calls[0]?.[0]).toBe('d3');
    expect((api.updateDraft.mock.calls[0]?.[1] as { field_schema: { title: string } }).field_schema.title).toBe('New wording');
  });

  it('discard draft: ⋯ → Discard draft… → confirm deletes the draft and reloads', async () => {
    const api = makeApi([DRAFT, V2, V1]);
    renderStudio(MANAGER, api);
    await screen.findByDisplayValue('Right to Represent');
    api.listVersions.mockResolvedValue([V2, V1]);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard draft…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard draft v3?' });
    expect(within(dialog).getByText(/The active version is not changed/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(api.discardDraft).toHaveBeenCalledWith('d3'));
    expect(await screen.findByText('Draft v3 discarded.')).toBeInTheDocument();
    expect(api.listVersions).toHaveBeenCalledTimes(2);
  });

  it('Sections: the static organization set (no Agreed pay rate); Insert adds the content to the draft', async () => {
    renderStudio(MANAGER, makeApi([DRAFT, V2, V1]));
    await screen.findByDisplayValue('Right to Represent');
    fireEvent.click(screen.getByRole('tab', { name: 'Sections' }));
    const names = ['Representation clause', 'Job description', 'Exclusivity', 'Right to stop representation', 'Recruiter sign-off'];
    for (const n of names) expect(screen.getByText(n, { selector: '.pws-sec__name' })).toBeInTheDocument();
    expect(screen.queryByText(/Agreed pay/)).toBeNull();
    expect(screen.queryByText(/used in/)).toBeNull();
    const before = document.querySelectorAll('[data-block-id]').length;
    fireEvent.click(screen.getByRole('button', { name: 'Insert Exclusivity' }));
    await waitFor(() => expect(document.querySelectorAll('[data-block-id]').length).toBe(before + 1));
    expect(screen.getByText('Inserted Exclusivity.')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });
});

describe('Org Studio — the letterhead block (A1; directive §3.5)', () => {
  it('a logo-bearing draft shows the non-editable letterhead; Remove logo goes through DELETE …/logo and reloads', async () => {
    const withLogo = version('d3', 3, 'DRAFT', `${LOGO}${BODY}`, { logo: { asset_id: 'a1', mime: 'image/png' } });
    const api = makeApi([withLogo, V2, V1]);
    renderStudio(MANAGER, api);
    const block = await screen.findByTestId('studio-letterhead');
    expect(block).toHaveTextContent('Astre Consulting');
    expect(within(block).getByRole('img')).toHaveAttribute('src', '/logo/d3/a1');
    fireEvent.click(within(block).getByRole('button', { name: 'Remove logo' }));
    await waitFor(() => expect(api.removeLogo).toHaveBeenCalledWith('d3'));
    expect(await screen.findByText('Logo removed from the letterhead.')).toBeInTheDocument();
  });

  it('a logo-bearing draft saves with the node kept first (no logo_asset_mismatch)', async () => {
    const withLogo = version('d3', 3, 'DRAFT', `${LOGO}${BODY}`, { logo: { asset_id: 'a1', mime: 'image/png' } });
    const api = makeApi([withLogo, V2, V1]);
    renderStudio(MANAGER, api);
    const title = await screen.findByDisplayValue('Right to Represent');
    fireEvent.change(title, { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
    const html = (api.updateDraft.mock.calls[0]?.[1] as { field_schema: { html: string } }).field_schema.html;
    expect(html.startsWith(LOGO)).toBe(true);
    expect(html.split('data-asset').length - 1).toBe(1);
  });

  it('no logo yet: "+ Tenant logo" captures the organization profile logo onto the draft', async () => {
    const api = makeApi([DRAFT, V2, V1]);
    renderStudio(MANAGER, api);
    const add = await screen.findByTestId('studio-letterhead-add');
    fireEvent.click(within(add).getByRole('button', { name: '+ Tenant logo' }));
    await waitFor(() => expect(api.captureLogo).toHaveBeenCalledWith('d3'));
    expect(await screen.findByText('Tenant logo added to the letterhead.')).toBeInTheDocument();
  });

  it('no organization logo: the capture action is disabled', async () => {
    renderStudio(MANAGER, makeApi([DRAFT, V2, V1], template(), false));
    const add = await screen.findByTestId('studio-letterhead-add');
    expect(within(add).getByRole('button', { name: '+ Tenant logo' })).toBeDisabled();
  });

  it('a letterhead node without a captured logo blocks the save with a clear message', async () => {
    const mismatch = version('d3', 3, 'DRAFT', `${LOGO}${BODY}`, { logo: null });
    const api = makeApi([mismatch, V2, V1]);
    renderStudio(MANAGER, api);
    expect(await screen.findByTestId('studio-letterhead-warn')).toHaveTextContent('isn’t captured for this draft');
    fireEvent.change(screen.getByDisplayValue('Right to Represent'), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(LETTERHEAD_SAVE_BLOCKED.asset_missing)).toBeInTheDocument();
    expect(api.updateDraft).not.toHaveBeenCalled();
    // Taking the letterhead out resolves it; the save then goes through without the node.
    fireEvent.click(screen.getByRole('button', { name: 'Take out letterhead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.updateDraft).toHaveBeenCalledTimes(1));
    expect((api.updateDraft.mock.calls[0]?.[1] as { field_schema: { html: string } }).field_schema.html).not.toContain('data-asset');
  });
});

describe('Org template routes (Conforming Amendment #3)', () => {
  function renderRoutes(path: string, api = makeApi([DRAFT, V2, V1])) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/v1/me')) return okJson({ user: { display_name: 'Olive', email: 'o@acme.test' }, roles: [], tenant: { display_name: 'Acme', status: 'ACTIVE' } });
      if (url === '/v1/document-templates/tpl-1') return okJson(template());
      if (url === '/v1/document-templates/tpl-1/versions') return okJson([DRAFT, V2, V1]);
      if (url === '/v1/document-templates/tpl-1/allowed-bindings') return okJson({ bindings: BINDINGS, tenant_logo: null });
      if (url.startsWith('/v1/document-templates/library')) return okJson(LIBRARY);
      return okJson({});
    });
    void api;
    return render(
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/org/document-templates/*" element={<DocumentTemplatesRoutes session={MANAGER} organizationHref="/org/overview" admin />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </ToastProvider>,
    );
  }

  it(':templateId opens the Template Studio (the former detail screen is gone)', async () => {
    renderRoutes('/org/document-templates/tpl-1');
    expect(await screen.findByTestId('org-template-studio')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Approve & activate v3/ })).toBeInTheDocument();
  });

  it(':templateId/draft redirects to :templateId', async () => {
    renderRoutes('/org/document-templates/tpl-1/draft');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/org\/document-templates\/tpl-1$/));
    expect(await screen.findByTestId('org-template-studio')).toBeInTheDocument();
  });

  it('the Studio paths are the full-width routes; the gallery preview belongs to the Template gallery', () => {
    expect(isOrgStudioPath('/org/document-templates/tpl-1')).toBe(true);
    expect(isOrgStudioPath('/org/document-templates/aramo/def-1')).toBe(true);
    expect(isOrgStudioPath('/org/document-templates')).toBe(false);
    expect(isOrgStudioPath('/org/document-templates/gallery')).toBe(false);
    expect(isOrgStudioPath('/org/document-templates/new')).toBe(false);
    expect(isOrgStudioPath('/org/document-templates/tpl-1/draft')).toBe(false);
    expect(isOrgStudioPath('/org/overview')).toBe(false);
    expect(orgSectionForPath('/org/document-templates/tpl-1')?.key).toBe('templates');
    expect(orgSectionForPath('/org/document-templates/aramo/def-1')?.key).toBe('gallery');
  });
});
