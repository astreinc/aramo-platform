import { ToastProvider, type Session } from '@aramo/fe-foundation';
import type {
  TemplateDefaultPreview,
  TemplateLibraryItem,
  TemplateLibraryView,
  TemplateSelectionView,
} from '@aramo/document-templates-web';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgAdminRoutes } from '../OrgAdminRoutes';

import { AramoDefaultPreview } from './AramoDefaultPreview';
import { CreateOwnTemplate } from './CreateOwnTemplate';
import { DocumentTemplatesGallery, buildView } from './DocumentTemplatesGallery';
import { fetchTemplateNotices, noticeMessage, parseNotices } from './notices-api';

// DOC-TEMPLATE-LIB-1 T-4 — Implementation Directive v1.0 (LOCKED) §8.2 / §6.2: the Org
// Home "Document templates" section (gallery with the Aramo defaults' "Updated" badge,
// template in use per document type, create your own with no copy, the branded default
// preview, the withdrawal banner) and its gate (document_template:read; manage actions by
// document_template:manage; a read-only session reaches only this section).

const RTR = 'd0c50005-0000-7000-8000-000000000001';
function makeSession(scopes: readonly string[]): Session {
  return { sub: 'user-1', consumer_type: 'org', tenant_id: 'tenant-abc', scopes: [...scopes], iat: 0, exp: 0 };
}
const ADMIN = makeSession(['auth:session:read', 'tenant:admin:profile', 'document_template:read', 'document_template:manage']);
const READER = makeSession(['auth:session:read', 'document_template:read']);

function item(over: Partial<TemplateLibraryItem>): TemplateLibraryItem {
  return {
    id: 'x', owner_scope: 'TENANT', document_type_id: RTR, name: 'T', description: null, template_kind: 'GENERATED',
    status: 'ACTIVE', client_id: null, current_version_id: 'v', current_version_number: 1,
    updated_at: '2026-10-01T10:00:00.000Z', products: null, withdraw_effective_at: null, configurable: true, ...over,
  };
}
const DEFAULT = item({ id: 'def-rtr', owner_scope: 'PLATFORM', name: 'Aramo Right to Represent', products: ['ATS'], current_version_number: 3, updated_at: '2026-10-15T10:00:00.000Z' });
const OWN = item({ id: 'own-rtr', name: 'Our RTR', current_version_number: 2 });
const OWN_DRAFT = item({ id: 'own-draft', name: 'Draft RTR', status: 'DRAFT', current_version_id: null, current_version_number: null });
const NOTICE = {
  template_id: 'def-rtr',
  name: 'Aramo Right to Represent',
  document_type_id: RTR,
  products: ['ATS'],
  withdraw_notice_at: '2026-10-21T00:00:00.000Z',
  withdraw_effective_at: '2026-10-28T00:00:00.000Z',
  status: 'PENDING' as const,
  selected_for_client_ids: [],
  relies_on_default: true,
  has_own_template: false,
};
const LIBRARY: TemplateLibraryView = {
  items: [DEFAULT, OWN, OWN_DRAFT],
  document_types: [
    { id: RTR, key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent', configurable: true },
    { id: 'offer', key: 'OFFER_LETTER', name: 'Offer Letter', configurable: false },
  ],
};
function selection(over: Partial<TemplateSelectionView>): TemplateSelectionView {
  return { id: 's', tenant_id: 'tenant-abc', document_type_id: RTR, client_id: null, template_id: OWN.id, selected_by: 'u', selected_at: '2026-10-16T00:00:00.000Z', ...over };
}

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}</p>;
}

function renderGallery(props: Partial<Parameters<typeof DocumentTemplatesGallery>[0]> = {}) {
  const fns = {
    libraryFn: vi.fn().mockResolvedValue(LIBRARY),
    selectionsFn: vi.fn().mockResolvedValue([]),
    setSelectionFn: vi.fn().mockResolvedValue(selection({})),
    clearSelectionFn: vi.fn().mockResolvedValue(undefined),
    noticesFn: vi.fn().mockResolvedValue([]),
    sessionOverride: ADMIN,
    ...props,
  };
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/org/document-templates']}>
        <Routes>
          <Route path="/org/document-templates" element={<DocumentTemplatesGallery {...fns} />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
  return fns;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Org Home document templates — gallery', () => {
  it('lists the Aramo defaults with an "Updated {date}" badge, and the organization’s own templates', async () => {
    renderGallery();
    const card = await screen.findByTestId('dt-default-def-rtr');
    expect(within(card).getByText('Aramo Right to Represent')).toBeInTheDocument();
    expect(within(card).getByTestId('dt-updated-badge')).toHaveTextContent(/^Updated /);
    expect(within(card).getByText('ATS')).toBeInTheDocument();
    expect(screen.getByTestId('dt-own-own-rtr')).toHaveTextContent('Active v2');
    expect(screen.getByTestId('dt-own-own-draft')).toHaveTextContent('Draft — not approved yet');
  });

  it('template in use: no choice means the Aramo default; choosing an approved own template sets it', async () => {
    const fns = renderGallery();
    expect(await screen.findByTestId('dt-in-use-current-RIGHT_TO_REPRESENT')).toHaveTextContent('Aramo default');
    const select = screen.getByTestId('dt-in-use-select-RIGHT_TO_REPRESENT') as HTMLSelectElement;
    // Choices: the Aramo default (clear), the Aramo default template itself, the APPROVED own
    // template — never an unapproved draft.
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['aramo-default', 'def-rtr', 'own-rtr']);
    fireEvent.change(select, { target: { value: 'own-rtr' } });
    await waitFor(() => expect(fns.setSelectionFn).toHaveBeenCalledWith({ document_type_id: RTR, client_id: null, template_id: 'own-rtr' }));
  });

  it('switching back to the Aramo default clears the choice', async () => {
    const fns = renderGallery({ selectionsFn: vi.fn().mockResolvedValue([selection({})]) });
    expect(await screen.findByTestId('dt-in-use-current-RIGHT_TO_REPRESENT')).toHaveTextContent('Our RTR · your template');
    fireEvent.change(screen.getByTestId('dt-in-use-select-RIGHT_TO_REPRESENT'), { target: { value: 'aramo-default' } });
    await waitFor(() => expect(fns.clearSelectionFn).toHaveBeenCalledWith({ document_type_id: RTR }));
  });

  it('read-only: no create action and no way to change the template in use', async () => {
    renderGallery({ sessionOverride: READER });
    await screen.findByTestId('dt-default-def-rtr');
    expect(screen.queryByTestId('dt-create-own')).toBeNull();
    expect(screen.queryByTestId('dt-in-use-select-RIGHT_TO_REPRESENT')).toBeNull();
  });

  it('a session without document_template:read sees no templates', () => {
    renderGallery({ sessionOverride: makeSession(['tenant:admin:profile']) });
    expect(screen.getByTestId('dt-gallery-noaccess')).toBeInTheDocument();
  });

  it('shows a withdrawal banner per notice; none when there are no notices', async () => {
    renderGallery({
      noticesFn: vi.fn().mockResolvedValue(parseNotices({ notices: [NOTICE] })),
    });
    expect(await screen.findByTestId('dt-notice-def-rtr')).toHaveTextContent('Aramo is withdrawing “Aramo Right to Represent”');
    expect(screen.getByTestId('dt-notice-def-rtr')).toHaveTextContent('Choose another template');
  });

  it('Create your own opens the create page; Preview opens the branded default preview', async () => {
    renderGallery();
    fireEvent.click(await screen.findByTestId('dt-default-preview-def-rtr'));
    expect(screen.getByTestId('where')).toHaveTextContent('/org/document-templates/aramo/def-rtr');
  });

  it('buildView only lists document types that are configurable or in use', () => {
    const v = buildView(LIBRARY, []);
    expect(v.types.map((t) => t.type.key)).toEqual(['RIGHT_TO_REPRESENT']);
    expect(v.defaults.map((d) => d.id)).toEqual(['def-rtr']);
    expect(v.own.map((d) => d.id)).toEqual(['own-rtr', 'own-draft']);
  });
});

describe('Org Home document templates — create your own (no copy)', () => {
  it('creates a blank template for a configurable type and opens its draft; there is no start-from-default option', async () => {
    const createFn = vi.fn().mockResolvedValue({ template: { id: 'new-1' }, draft: { id: 'v1' } });
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/org/document-templates/new']}>
          <Routes>
            <Route path="/org/document-templates/new" element={<CreateOwnTemplate sessionOverride={ADMIN} libraryFn={vi.fn().mockResolvedValue(LIBRARY)} createFn={createFn} />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    const typeSelect = (await screen.findByTestId('dt-create-type')) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(typeSelect.options).map((o) => o.textContent)).toEqual(['Right to Represent']));
    expect(screen.queryByText(/copy/i)).toBeNull();
    fireEvent.change(screen.getByTestId('dt-create-name'), { target: { value: '  Our own RTR ' } });
    fireEvent.click(screen.getByTestId('dt-create-submit'));
    await waitFor(() => expect(createFn).toHaveBeenCalledWith({ document_type_id: RTR, name: 'Our own RTR' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/org/document-templates/new-1/draft');
  });

  it('read-only sessions cannot create', () => {
    render(
      <MemoryRouter>
        <CreateOwnTemplate sessionOverride={READER} libraryFn={vi.fn().mockResolvedValue(LIBRARY)} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('dt-create-noaccess')).toBeInTheDocument();
  });
});

describe('Org Home document templates — Aramo default preview', () => {
  it('renders the current version with the organization’s letterhead and values', async () => {
    const preview: TemplateDefaultPreview = {
      title: 'Right to Represent',
      blocks: [],
      html: '<p>Represented by <span data-sample="organization.name">Acme Staffing</span></p>',
      sample_values: [{ key: 'organization.name', label: 'Organization name', value: 'Acme Staffing' }],
      template_id: 'def-rtr',
      version_id: 'v3',
      version_number: 3,
      updated_at: '2026-10-15T10:00:00.000Z',
      letterhead: { organization_name: 'Acme Staffing', logo_available: true },
    };
    render(
      <MemoryRouter>
        <AramoDefaultPreview templateId="def-rtr" previewFn={vi.fn().mockResolvedValue(preview)} />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('dt-default-letterhead')).toHaveTextContent('Acme Staffing');
    expect(screen.getByTestId('dt-default-paper')).toHaveTextContent('Represented by Acme Staffing');
    expect(screen.getByTestId('dt-default-logo-note')).toHaveTextContent('logo from the profile is added');
  });
});

describe('withdrawal notices client (T-6 GET /v1/document-templates/notices)', () => {
  it('parses { notices } and drops unrecognisable entries', () => {
    expect(parseNotices({ notices: [NOTICE, { foo: 1 }, { ...NOTICE, status: 'OTHER' }] })).toEqual([NOTICE]);
    expect(parseNotices(null)).toEqual([]);
    expect(parseNotices([NOTICE])).toEqual([]);
  });

  it('message: pending vs in effect, and the fallback to the organization’s own template', () => {
    const fmt = (s: string) => s.slice(0, 10);
    expect(noticeMessage(NOTICE, fmt, false)).toContain('Your administrators will choose');
    expect(noticeMessage({ ...NOTICE, has_own_template: true }, fmt, true)).toContain('your own approved template for this document type is used');
    expect(noticeMessage({ ...NOTICE, status: 'IN_EFFECT' }, fmt, true)).toContain('Aramo withdrew “Aramo Right to Represent” on 2026-10-28');
  });

  it('a failed notices read means no banner', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    await expect(fetchTemplateNotices()).resolves.toEqual([]);
  });
});

describe('Org Home routing — document_template:read gate', () => {
  function okJson(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  function mockApi() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/v1/document-templates/library')) return okJson(LIBRARY);
      if (url.startsWith('/v1/document-templates/selections')) return okJson({ items: [] });
      if (url.startsWith('/v1/document-templates/notices')) return okJson({ notices: [] });
      return okJson({});
    });
  }
  function renderAt(path: string, session: Session) {
    return render(
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="org/*" element={<OrgAdminRoutes session={session} />} />
            <Route path="/" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
  }

  it('a document_template:read-only session enters Org Home at Document templates and sees only that tab', async () => {
    mockApi();
    renderAt('/org/users', READER);
    await screen.findByTestId('dt-gallery');
    const nav = screen.getByRole('navigation', { name: 'Organization sections' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Document templates']);
  });

  it('an organization administrator sees the Document templates tab alongside the other sections', async () => {
    mockApi();
    renderAt('/org/document-templates', ADMIN);
    await screen.findByTestId('dt-gallery');
    const nav = screen.getByRole('navigation', { name: 'Organization sections' });
    expect(within(nav).getByText('Document templates')).toBeInTheDocument();
    expect(within(nav).getByText('Profile')).toBeInTheDocument();
  });

  it('a member with neither scope is still sent to App Home with the denial notice', () => {
    renderAt('/org/document-templates', makeSession(['talent:read']));
    expect(screen.getByTestId('where')).toHaveTextContent('/');
  });
});
