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

import { AramoDefaultStudio, actionFor } from './AramoDefaultStudio';
import { CreateOwnTemplate } from './CreateOwnTemplate';
import { fetchTemplateNotices, noticeMessage, parseNotices } from './notices-api';
import { LEGACY_BANNER_TEXT, OurTemplatesPage } from './OurTemplatesPage';
import { RESPONSIBILITY_SENTENCE, TemplateGalleryPage } from './TemplateGalleryPage';
import { buildGalleryCards, categoryCounts } from './templates-view';

// ORG-UX-1 (Directive v1.0 LOCKED §4.1, §5, §8.8; handoff rev. Oct 21 §6.8/§6.9) — Our
// templates (table, legacy "Aramo starting point" banner, footnote to the gallery), the
// Template gallery (category chips + counts, horizontal cards, Adopt for supported types
// and authors only, "In Our templates", "Not configurable yet"), create your own (no copy),
// the withdrawal banner, and the org_access-driven routing. TEMPLATE-STUDIO-1 S-2 (directive
// §4): the gallery is built from the backend library (published Aramo defaults only; no
// static cards); a card opens the Aramo default in the shared Studio, read only, in Preview;
// Adopt is the Studio's header action (authors / managers only) → the new tenant template.

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

// Library fixtures beyond RTR: an Aramo default of a future publishable type, a tenant item
// of another type, a default whose type is not template-driven, and an unmapped type.
const OFFER = 'dt-offer';
const NDA = 'dt-nda';
const ODD = 'dt-odd';
const WIDE: TemplateLibraryView = {
  items: [
    DEFAULT,
    item({ id: 'def-offer', owner_scope: 'PLATFORM', document_type_id: OFFER, name: 'Aramo Offer letter', description: null }),
    item({ id: 'def-nda', owner_scope: 'PLATFORM', document_type_id: NDA, name: 'Aramo Client NDA', configurable: false }),
    item({ id: 'def-odd', owner_scope: 'PLATFORM', document_type_id: ODD, name: 'Aramo Other', description: 'Custom copy.' }),
    item({ id: 'own-offer', document_type_id: OFFER, name: 'Our offer' }),
  ],
  document_types: [
    { id: RTR, key: 'RIGHT_TO_REPRESENT', name: 'Right to Represent', configurable: true },
    { id: OFFER, key: 'OFFER_LETTER', name: 'Offer Letter', configurable: true },
    { id: NDA, key: 'CLIENT_NDA', name: 'Client NDA', configurable: false },
    { id: ODD, key: 'SOMETHING_NEW', name: 'Something new', configurable: true },
  ],
};

describe('Template gallery — backend-driven (TEMPLATE-STUDIO-1 S-2)', () => {
  it('header carries the intro and the responsibility sentence', async () => {
    renderGallery();
    expect(screen.getByRole('heading', { level: 1, name: 'Template gallery' })).toBeInTheDocument();
    expect(screen.getByText(/Ready-made starting points\. Adopting one creates a draft in Our templates/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(RESPONSIBILITY_SENTENCE.replace(/\./g, "\\.")))).toBeInTheDocument();
    await screen.findByTestId('gallery-preview');
  });

  it('one card per published Aramo default from the library; tenant templates are not cards; no static cards', async () => {
    renderGallery({ libraryFn: vi.fn().mockResolvedValue(LIBRARY) });
    const rtr = await screen.findByRole('article', { name: 'Aramo Right to Represent' });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(within(rtr).getByRole('heading', { level: 3, name: 'Aramo Right to Represent' })).toBeInTheDocument();
    // description null → the document-type fallback copy; category from the type key.
    expect(rtr).toHaveTextContent('Authorizes your firm to submit the talent to one client for one requisition, with the agreed pay rate.');
    expect(rtr).toHaveTextContent('Recruiting');
    expect(rtr.querySelector('[aria-hidden="true"]')).not.toBeNull();
    for (const name of ['Our RTR', 'Draft RTR', 'Offer letter', 'Client NDA', 'Background check authorization', 'I-9 Employment eligibility']) {
      expect(screen.queryByRole('article', { name })).toBeNull();
    }
    expect(screen.queryByText('Not configurable yet')).toBeNull();
  });

  it('buildGalleryCards: PLATFORM + template-driven only; description falls back by type; unmapped → Other; in-ours vs adoptable', () => {
    const cards = buildGalleryCards(WIDE);
    expect(cards.map((c) => [c.id, c.name, c.category, c.state.kind])).toEqual([
      ['def-rtr', 'Aramo Right to Represent', 'Recruiting', 'adoptable'],
      ['def-offer', 'Aramo Offer letter', 'Hiring', 'in-ours'],
      ['def-odd', 'Aramo Other', 'Other', 'adoptable'],
    ]);
    expect(cards[1]?.state).toEqual({ kind: 'in-ours', ourTemplateId: 'own-offer' });
    expect(cards[1]?.description).toBe('Confirms the role, start date, pay and terms offered to a talent before they start.');
    expect(cards[2]?.description).toBe('Custom copy.');
    expect(categoryCounts(cards)).toEqual({ All: 3, Recruiting: 1, Hiring: 1, Legal: 0, 'Pre-start': 0, Other: 1 });
    expect(buildGalleryCards({ items: [OWN, OWN_DRAFT], document_types: LIBRARY.document_types })).toEqual([]);
  });

  it('category chips come from the actual cards (empty categories hidden); filtering is client-side', async () => {
    renderGallery({ libraryFn: vi.fn().mockResolvedValue(WIDE) });
    await screen.findByRole('article', { name: 'Aramo Right to Represent' });
    const bar = screen.getByRole('toolbar', { name: 'Filter by category' });
    expect(within(bar).getAllByRole('button').map((c) => c.textContent)).toEqual(['All3', 'Recruiting1', 'Hiring1', 'Other1']);
    expect(screen.getByTestId('gallery-chip-All')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('gallery-chip-Hiring'));
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Aramo Offer letter']);
    fireEvent.click(screen.getByTestId('gallery-chip-All'));
    expect(screen.getAllByRole('article')).toHaveLength(3);
  });

  it('adoptable: Preview opens the Aramo default in the Studio; no Adopt on the card', async () => {
    renderGallery();
    const rtr = await screen.findByRole('article', { name: 'Aramo Right to Represent' });
    expect(within(rtr).queryByTestId('gallery-in-ours')).toBeNull();
    expect(within(rtr).queryByRole('button', { name: /Adopt/ })).toBeNull();
    fireEvent.click(within(rtr).getByTestId('gallery-preview'));
    expect(screen.getByTestId('where')).toHaveTextContent('/org/document-templates/aramo/def-rtr');
  });

  it('a click anywhere on the card opens the Studio', async () => {
    renderGallery();
    fireEvent.click(await screen.findByRole('heading', { level: 3, name: 'Aramo Right to Represent' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/org/document-templates/aramo/def-rtr');
  });

  it('in Our templates: an "In Our templates" link to the organization’s template + Preview', async () => {
    renderGallery({ libraryFn: vi.fn().mockResolvedValue(LIBRARY) });
    const rtr = await screen.findByRole('article', { name: 'Aramo Right to Represent' });
    const link = await within(rtr).findByTestId('gallery-in-ours');
    expect(link).toHaveTextContent('In Our templates');
    expect(within(rtr).getByTestId('gallery-preview')).toBeInTheDocument();
    fireEvent.click(link);
    expect(screen.getByTestId('where')).toHaveTextContent('/org/document-templates/own-rtr');
  });

  it('no published defaults: an empty state, no chips', async () => {
    renderGallery({ libraryFn: vi.fn().mockResolvedValue({ items: [OWN], document_types: LIBRARY.document_types }) });
    expect(await screen.findByTestId('gallery-empty')).toHaveTextContent('No Aramo templates are published yet.');
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('a library read failure shows an alert with Try again', async () => {
    const libraryFn = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(NO_OWN);
    renderGallery({ libraryFn });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('article', { name: 'Aramo Right to Represent' })).toBeInTheDocument();
  });

  it('no use-the-default-directly affordance remains', async () => {
    renderGallery({ session: ADMIN });
    await screen.findByTestId('gallery-preview');
    expect(screen.queryByText(/Aramo default \(recommended\)|Template in use|switch back/i)).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('Aramo default in the Studio — read only + Adopt (TEMPLATE-STUDIO-1 S-2)', () => {
  const PREVIEW: TemplateDefaultPreview = {
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

  function renderStudio(over: Partial<Parameters<typeof AramoDefaultStudio>[0]> = {}) {
    stubMe();
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    const fns = {
      session: AUTHOR,
      templateId: 'def-rtr',
      libraryFn: vi.fn().mockResolvedValue(NO_OWN),
      previewFn: vi.fn().mockResolvedValue(PREVIEW),
      adoptFn: vi.fn().mockResolvedValue({ template: { id: 'adopted-1' }, version: { id: 'v1' } }),
      ...over,
    };
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/org/document-templates/aramo/def-rtr']}>
          <Routes>
            <Route path="/org/document-templates/aramo/:templateId" element={<AramoDefaultStudio {...fns} />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    return fns;
  }

  it('opens read only in Preview with the organization’s branding; no edit, approve, Versions, Compare or Checks', async () => {
    const fns = renderStudio();
    const pages = await screen.findByRole('region', { name: 'Preview pages' });
    await waitFor(() => expect(pages).toHaveTextContent('Represented by Acme Staffing'));
    expect(fns.previewFn).toHaveBeenCalledWith('def-rtr');
    // Acceptance §11 item 3: never editable, so no Edit | Preview toggle, readiness pill or Checks tab.
    expect(screen.queryByRole('group', { name: 'Mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Edit|Preview)$/ })).toBeNull();
    expect(screen.queryByTitle('Publishing checks')).toBeNull();
    expect(screen.queryByRole('tab', { name: /Checks/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save|Approve|Publish|Compare|Discard/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Versions' })).toBeNull();
  });

  it('an author adopts: the confirmation carries the responsibility sentence → POST /adopt → toast → the new template', async () => {
    const fns = renderStudio();
    fireEvent.click(await screen.findByTestId('studio-adopt'));
    const modal = await screen.findByTestId('gallery-adopt-modal');
    expect(modal).toHaveTextContent('Adopt Aramo Right to Represent?');
    expect(modal).toHaveTextContent(RESPONSIBILITY_SENTENCE);
    expect(modal).toHaveTextContent('Nothing is used until it’s approved.');
    fireEvent.click(within(modal).getByTestId('gallery-adopt-confirm'));
    await waitFor(() => expect(fns.adoptFn).toHaveBeenCalledWith('def-rtr'));
    expect(await screen.findByTestId('where')).toHaveTextContent('/org/document-templates/adopted-1');
    expect(screen.getByTestId('where').textContent).toBe('/org/document-templates/adopted-1');
    expect(screen.getByText('Aramo Right to Represent added to Our templates as a draft. Nothing is used until it’s approved.')).toBeInTheDocument();
  });

  it('an adopt refusal stays in the dialog as an alert', async () => {
    renderStudio({ adoptFn: vi.fn().mockRejectedValue(new Error('nope')) });
    fireEvent.click(await screen.findByTestId('studio-adopt'));
    fireEvent.click(await screen.findByTestId('gallery-adopt-confirm'));
    expect(await within(screen.getByTestId('gallery-adopt-modal')).findByRole('alert')).toBeInTheDocument();
  });

  it('a manage holder (owner/admin) is offered Adopt too', async () => {
    renderStudio({ session: ADMIN });
    expect(await screen.findByTestId('studio-adopt')).toBeInTheDocument();
  });

  it('a read-only session previews but is never offered Adopt', async () => {
    renderStudio({ session: READER });
    const pages = await screen.findByRole('region', { name: 'Preview pages' });
    await waitFor(() => expect(pages).toHaveTextContent('Acme Staffing'));
    expect(screen.queryByTestId('studio-adopt')).toBeNull();
    expect(screen.queryByTestId('studio-in-ours')).toBeNull();
  });

  it('when the organization already has a template of the type: "In Our templates" link, no Adopt', async () => {
    renderStudio({ libraryFn: vi.fn().mockResolvedValue(LIBRARY) });
    const link = await screen.findByTestId('studio-in-ours');
    expect(link).toHaveAttribute('href', '/org/document-templates/own-rtr');
    expect(screen.queryByTestId('studio-adopt')).toBeNull();
  });

  it('actionFor: adopt / in-ours / none', () => {
    expect(actionFor(null, 'def-rtr', true)).toEqual({ kind: 'none' });
    expect(actionFor(NO_OWN, 'def-rtr', true)).toEqual({ kind: 'adopt', name: 'Aramo Right to Represent' });
    expect(actionFor(NO_OWN, 'def-rtr', false)).toEqual({ kind: 'none' });
    expect(actionFor(LIBRARY, 'def-rtr', true)).toEqual({ kind: 'in-ours', ourTemplateId: 'own-rtr' });
    expect(actionFor(LIBRARY, 'own-rtr', true)).toEqual({ kind: 'none' });
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

describe('Our templates — Create new version (TEMPLATE-STUDIO-1 §1.4, §3.4)', () => {
  it('an approved template with no draft offers it; a draft-only template does not; click → POST /:id/draft → the Studio', async () => {
    const createDraftFn = vi.fn().mockResolvedValue(vers('nv3', 'own-rtr', 3, 'DRAFT', null));
    renderOurs({ createDraftFn });
    const row = await screen.findByTestId('our-template-own-rtr');
    const create = within(row).getByRole('button', { name: 'Create new version v3 of Our RTR' });
    expect(create).toHaveTextContent('Create new version');
    expect(within(screen.getByTestId('our-template-own-draft')).queryByRole('button', { name: /Create new version/ })).toBeNull();
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/org/document-templates/own-rtr'));
    expect(createDraftFn).toHaveBeenCalledWith('own-rtr');
  });

  it('an author is offered it too', async () => {
    renderOurs({ session: AUTHOR });
    const row = await screen.findByTestId('our-template-own-rtr');
    expect(within(row).getByRole('button', { name: 'Create new version v3 of Our RTR' })).toBeInTheDocument();
  });

  it('read-only sessions never see it', async () => {
    renderOurs({ session: READER });
    await screen.findByTestId('our-template-own-rtr');
    expect(screen.queryByRole('button', { name: /Create new version/ })).toBeNull();
  });

  it('an approved template that already has an open draft: no action (Manage opens the draft)', async () => {
    const versionsFn = vi.fn().mockResolvedValue([vers('v', 'own-rtr', 2, 'ACTIVE', '2026-10-09T10:00:00.000Z'), vers('d3', 'own-rtr', 3, 'DRAFT', null)]);
    renderOurs({ libraryFn: vi.fn().mockResolvedValue({ ...LIBRARY, items: [OWN] }), versionsFn });
    const row = await screen.findByTestId('our-template-own-rtr');
    expect(within(row).queryByRole('button', { name: /Create new version/ })).toBeNull();
    expect(within(row).getByRole('link', { name: 'Manage Our RTR' })).toBeInTheDocument();
  });

  it('a refusal stays on the row as an alert', async () => {
    const createDraftFn = vi.fn().mockRejectedValue(new Error('A draft is already open.'));
    renderOurs({ createDraftFn });
    const row = await screen.findByTestId('our-template-own-rtr');
    fireEvent.click(within(row).getByRole('button', { name: /Create new version/ }));
    expect(await within(row).findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('where')).toBeNull();
  });
});

describe('Org Home document templates — create your own (no copy)', () => {
  it('creates a blank template for a configurable type and opens it in the Studio (TEMPLATE-STUDIO-1 S-1); there is no start-from-default option', async () => {
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
    expect(await screen.findByTestId('where')).toHaveTextContent(/^\/org\/document-templates\/new-1$/);
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

