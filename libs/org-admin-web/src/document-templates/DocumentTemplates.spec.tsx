import { ToastProvider, type Session } from '@aramo/fe-foundation';
import type {
  TemplateDefaultPreview,
  TemplateLibraryItem,
  TemplateLibraryView,
  TemplateSelectionView,
  TemplateVersionView,
} from '@aramo/document-templates-web';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgAdminRoutes } from '../OrgAdminRoutes';

import { AramoDefaultPreview } from './AramoDefaultPreview';
import { CreateOwnTemplate } from './CreateOwnTemplate';
import { fetchTemplateNotices, noticeMessage, parseNotices } from './notices-api';
import { LEGACY_BANNER_TEXT, OurTemplatesPage } from './OurTemplatesPage';
import { RESPONSIBILITY_SENTENCE, TemplateGalleryPage } from './TemplateGalleryPage';
import { categoryCounts, GALLERY_ENTRIES } from './templates-view';

// ORG-UX-1 (Directive v1.0 LOCKED §4.1, §5, §8.8; handoff rev. Oct 21 §6.8/§6.9) — Our
// templates (table, legacy "Aramo starting point" banner, footnote to the gallery), the
// Template gallery (category chips + counts, horizontal cards, Adopt for supported types
// and authors only, "In Our templates", "Not configurable yet"), create your own (no copy),
// the branded default preview, the withdrawal banner, and the org_access-driven routing.

const RTR = 'd0c50005-0000-7000-8000-000000000001';
function makeSession(scopes: readonly string[]): Session {
  return { sub: 'user-1', consumer_type: 'org', tenant_id: 'tenant-abc', scopes: [...scopes], iat: 0, exp: 0 };
}
const ADMIN = makeSession(['auth:session:read', 'tenant:admin:profile', 'document_template:read', 'document_template:manage']);
const READER = makeSession(['auth:session:read', 'document_template:read']);
// ORG-UX-1 §4.1 — an author (account manager, recruiting manager, lead recruiter): adopt /
// create / edit, never approve.
const AUTHOR = makeSession(['auth:session:read', 'document_template:read', 'document_template:author']);

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

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
// OrgPageHeader reads /v1/me for the organization name.
function stubMe() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('/v1/me')) return okJson({ user: { display_name: 'Olive', email: 'o@acme.test' }, roles: [], tenant: { display_name: 'Acme', status: 'ACTIVE' } });
    return okJson({});
  });
}

function vers(id: string, templateId: string, n: number, status: TemplateVersionView['status'], activatedAt: string | null): TemplateVersionView {
  return {
    id, tenant_id: 'tenant-abc', template_id: templateId, version_number: n, status, render_schema_version: 'rtr-html-v1', field_schema: {},
    binding_schema: null, created_by: 'u-author', created_at: '2026-10-01T00:00:00.000Z', activated_at: activatedAt,
    activated_by: activatedAt === null ? null : 'u-approver', retired_at: null, content_fingerprint: null, previewed_fingerprint: null,
  };
}

const NO_OWN: TemplateLibraryView = { ...LIBRARY, items: [DEFAULT] };

function renderGallery(props: Partial<Parameters<typeof TemplateGalleryPage>[0]> = {}) {
  stubMe();
  const fns = {
    session: AUTHOR,
    libraryFn: vi.fn().mockResolvedValue(NO_OWN),
    adoptFn: vi.fn().mockResolvedValue({ template: { id: 'adopted-1' }, version: { id: 'v1' } }),
    ...props,
  };
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/org/document-templates/gallery']}>
        <Routes>
          <Route path="/org/document-templates/gallery" element={<TemplateGalleryPage {...fns} />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
  return fns;
}

function renderOurs(props: Partial<Parameters<typeof OurTemplatesPage>[0]> = {}) {
  stubMe();
  const fns = {
    session: ADMIN,
    libraryFn: vi.fn().mockResolvedValue(LIBRARY),
    selectionsFn: vi.fn().mockResolvedValue([]),
    versionsFn: vi.fn().mockImplementation((id: string) =>
      Promise.resolve(
        id === 'own-rtr'
          ? [vers('ov1', 'own-rtr', 1, 'RETIRED', '2026-09-01T10:00:00.000Z'), { ...vers('v', 'own-rtr', 2, 'ACTIVE', '2026-10-09T10:00:00.000Z') }]
          : [vers('dv1', 'own-draft', 1, 'DRAFT', null)],
      ),
    ),
    namesFn: vi.fn().mockResolvedValue({ 'u-approver': 'Purush P.' }),
    noticesFn: vi.fn().mockResolvedValue([]),
    ...props,
  };
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/org/document-templates']}>
        <Routes>
          <Route path="/org/document-templates" element={<OurTemplatesPage {...fns} />} />
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

describe('Template gallery (§6.9 revised)', () => {
  it('header carries the intro and the responsibility sentence', async () => {
    renderGallery();
    expect(screen.getByRole('heading', { level: 1, name: 'Template gallery' })).toBeInTheDocument();
    expect(screen.getByText(/Ready-made starting points\. Adopting one creates a draft in Our templates/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(RESPONSIBILITY_SENTENCE.replace(/\./g, "\\.")))).toBeInTheDocument();
    await screen.findByTestId('gallery-adopt');
  });

  it('category chips: All · Recruiting · Hiring · Legal · Pre-start with counts; filtering is client-side', async () => {
    renderGallery();
    const bar = screen.getByRole('toolbar', { name: 'Filter by category' });
    const chips = within(bar).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['All5', 'Recruiting1', 'Hiring1', 'Legal1', 'Pre-start2']);
    expect(chips[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('article')).toHaveLength(5);
    fireEvent.click(screen.getByTestId('gallery-chip-Pre-start'));
    expect(screen.getByTestId('gallery-chip-Pre-start')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('gallery-chip-All')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Background check authorization', 'I-9 Employment eligibility']);
    fireEvent.click(screen.getByTestId('gallery-chip-All'));
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(categoryCounts(GALLERY_ENTRIES)).toEqual({ All: 5, Recruiting: 1, Hiring: 1, Legal: 1, 'Pre-start': 2 });
  });

  it('cards: exact copy, decorative preview hidden, unsupported types show "Not configurable yet"', async () => {
    renderGallery();
    const rtr = await screen.findByRole('article', { name: 'Right to Represent' });
    expect(within(rtr).getByRole('heading', { level: 3, name: 'Right to Represent' })).toBeInTheDocument();
    expect(rtr).toHaveTextContent('Authorizes your firm to submit the talent to one client for one requisition, with the agreed pay rate.');
    expect(rtr.querySelector('[aria-hidden="true"]')).not.toBeNull();
    for (const name of ['Offer letter', 'Client NDA', 'Background check authorization', 'I-9 Employment eligibility']) {
      const card = screen.getByRole('article', { name });
      expect(within(card).getByTestId('gallery-not-configurable')).toHaveTextContent('Not configurable yet');
      expect(within(card).queryByRole('button')).toBeNull();
    }
  });

  it('a supported type not yet adopted: Adopt (author) + Preview; Adopt confirms with the responsibility sentence, adopts and opens the draft', async () => {
    const fns = renderGallery();
    const rtr = await screen.findByRole('article', { name: 'Right to Represent' });
    expect(within(rtr).queryByText('In Our templates')).toBeNull();
    fireEvent.click(within(rtr).getByTestId('gallery-adopt'));
    const modal = await screen.findByTestId('gallery-adopt-modal');
    expect(modal).toHaveTextContent(RESPONSIBILITY_SENTENCE);
    expect(modal).toHaveTextContent('Nothing is used until it’s approved.');
    fireEvent.click(within(modal).getByTestId('gallery-adopt-confirm'));
    await waitFor(() => expect(fns.adoptFn).toHaveBeenCalledWith('def-rtr'));
    expect(await screen.findByTestId('where')).toHaveTextContent('/org/document-templates/adopted-1/draft');
  });

  it('an adopt refusal stays in the dialog as an alert', async () => {
    const adoptFn = vi.fn().mockRejectedValue(new Error('nope'));
    renderGallery({ adoptFn });
    fireEvent.click(await screen.findByTestId('gallery-adopt'));
    fireEvent.click(await screen.findByTestId('gallery-adopt-confirm'));
    expect(await within(screen.getByTestId('gallery-adopt-modal')).findByRole('alert')).toBeInTheDocument();
  });

  it('Preview opens the branded read-only preview of the Aramo default', async () => {
    renderGallery();
    fireEvent.click(await screen.findByTestId('gallery-preview'));
    expect(screen.getByTestId('where')).toHaveTextContent('/org/document-templates/aramo/def-rtr');
  });

  it('a session without author or manage previews but is never offered Adopt', async () => {
    renderGallery({ session: READER });
    expect(await screen.findByTestId('gallery-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('gallery-adopt')).toBeNull();
  });

  it('a manage holder (owner/admin) is offered Adopt too', async () => {
    renderGallery({ session: ADMIN });
    expect(await screen.findByTestId('gallery-adopt')).toBeInTheDocument();
  });

  it('when the organization already has a template of the type: "In Our templates" + Preview, no Adopt', async () => {
    renderGallery({ libraryFn: vi.fn().mockResolvedValue(LIBRARY) });
    const rtr = await screen.findByRole('article', { name: 'Right to Represent' });
    expect(await within(rtr).findByTestId('gallery-in-ours')).toHaveTextContent('In Our templates');
    expect(within(rtr).getByTestId('gallery-preview')).toBeInTheDocument();
    expect(within(rtr).queryByTestId('gallery-adopt')).toBeNull();
  });

  it('no use-the-default-directly affordance remains', async () => {
    renderGallery({ session: ADMIN });
    await screen.findByTestId('gallery-adopt');
    expect(screen.queryByText(/Aramo default \(recommended\)|Template in use|switch back/i)).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('Our templates (§6.8)', () => {
  it('table: Template (name + type) · Used in · Version · Status · Last approved · Manage → the editor', async () => {
    renderOurs();
    const row = await screen.findByTestId('our-template-own-rtr');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Template', 'Used in', 'Version', 'Status', 'Last approved', 'Actions']);
    expect(row).toHaveTextContent('Our RTR');
    expect(row).toHaveTextContent('Right to Represent');
    expect(row).toHaveTextContent('ATS');
    expect(row).toHaveTextContent('v2');
    expect(within(row).getByText('Active')).toHaveClass('ox-pill--active');
    expect(row).toHaveTextContent('Oct 9, 2026 · Purush P.');
    const manage = within(row).getByRole('link', { name: 'Manage Our RTR' });
    expect(manage).toHaveAttribute('href', '/org/document-templates/own-rtr');

    const draft = screen.getByTestId('our-template-own-draft');
    expect(within(draft).getByText('Draft')).toHaveClass('ox-pill--warn');
    expect(draft).toHaveTextContent('v1');
    expect(draft).toHaveTextContent('—');
  });

  it('"Used in" falls back to All apps when no product tags are known', async () => {
    const lib: TemplateLibraryView = { ...LIBRARY, items: [OWN] };
    renderOurs({ libraryFn: vi.fn().mockResolvedValue(lib) });
    expect(await screen.findByTestId('our-template-own-rtr')).toHaveTextContent('All apps');
  });

  it('footnote links to the Template gallery', async () => {
    renderOurs();
    await screen.findByTestId('our-template-own-rtr');
    expect(screen.getByText(/Need a new document type\?/)).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Template gallery' });
    expect(links[links.length - 1]).toHaveAttribute('href', '/org/document-templates/gallery');
  });

  it('empty state points to the gallery', async () => {
    renderOurs({ libraryFn: vi.fn().mockResolvedValue(NO_OWN) });
    const empty = await screen.findByTestId('our-templates-empty');
    expect(within(empty).getByRole('link', { name: 'Template gallery' })).toHaveAttribute('href', '/org/document-templates/gallery');
  });

  it('a grandfathered tenant-wide legacy selection shows the "Aramo starting point" banner', async () => {
    renderOurs({ selectionsFn: vi.fn().mockResolvedValue([selection({ template_id: 'def-rtr', legacy_platform: true })]) });
    expect(await screen.findByTestId('our-templates-legacy')).toHaveTextContent(LEGACY_BANNER_TEXT);
    expect(within(screen.getByTestId('our-templates-legacy')).getByRole('link')).toHaveAttribute('href', '/org/document-templates/gallery');
  });

  it('no banner without a legacy selection (an ordinary or client-specific selection does not count)', async () => {
    renderOurs({ selectionsFn: vi.fn().mockResolvedValue([selection({}), selection({ client_id: 'c1', legacy_platform: true })]) });
    await screen.findByTestId('our-template-own-rtr');
    expect(screen.queryByTestId('our-templates-legacy')).toBeNull();
  });

  it('shows a withdrawal banner per notice', async () => {
    renderOurs({ noticesFn: vi.fn().mockResolvedValue(parseNotices({ notices: [NOTICE] })) });
    expect(await screen.findByTestId('dt-notice-def-rtr')).toHaveTextContent('Aramo is withdrawing “Aramo Right to Represent”');
  });

  it('offers no selection control (no "use the Aramo default" choice)', async () => {
    renderOurs();
    await screen.findByTestId('our-template-own-rtr');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/Aramo default \(recommended\)/)).toBeNull();
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

describe('Org routing — org_access (§4.3)', () => {
  function productsView(access: 'admin' | 'templates' | 'none') {
    return {
      tenant_id: 'tenant-abc',
      products: [{ key: 'org', subscribed: true, authorized: access !== 'none', available: access !== 'none', entry_path: '/org/', reason: null, org_access: access }],
    };
  }
  function mockApi(access: 'admin' | 'templates' | 'none') {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/v1/me/products')) return okJson(productsView(access));
      if (url.startsWith('/v1/me')) return okJson({ user: { display_name: 'Olive', email: 'o@acme.test' }, roles: [], tenant: { display_name: 'Acme', status: 'ACTIVE' } });
      if (url.startsWith('/v1/document-templates/library')) return okJson(LIBRARY);
      if (url.startsWith('/v1/document-templates/selections')) return okJson({ items: [] });
      if (url.startsWith('/v1/document-templates/notices')) return okJson({ notices: [] });
      if (/\/v1\/document-templates\/[^/]+\/versions/.test(url)) return okJson([]);
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

  it('a template author lands on Our templates and can open the gallery', async () => {
    mockApi('templates');
    renderAt('/org', AUTHOR);
    expect(await screen.findByTestId('our-templates')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('link', { name: 'Template gallery' })[0] as HTMLElement);
    expect(await screen.findByTestId('template-gallery')).toBeInTheDocument();
  });

  it('org_access none is sent to App Home with the denial notice', async () => {
    mockApi('none');
    renderAt('/org/document-templates', makeSession(['talent:read']));
    expect(await screen.findByTestId('where')).toHaveTextContent('/');
  });
});

