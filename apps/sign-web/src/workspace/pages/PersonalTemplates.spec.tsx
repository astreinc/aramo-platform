import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { SenderContext } from '../api';

import { ASK_ADMIN, personalStudioCopy, personalStudioDataSource } from './PersonalTemplates';

// Aramo-TEMPLATE-PRODUCT-1 §8.1–8.3 / §8.5 — Templates in the PERSONAL workspace: the nav item,
// Coming soon while sign.templates is unavailable, the Free plan's upgrade prompt (P-6), My
// templates + the Aramo (Sign) gallery with "Adopt and edit" / "Use as it is", the refusal
// "Ask an admin to approve this template", and the Studio running on the Sign calls with the
// Personal copy ("Use this version").

// TP-6 moved the PDF helpers to @aramo/document-templates-web/pdf (the old '../pdf' is gone).
vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));

const SESSION = { sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send', 'document_template:read'], iat: 0, exp: 9_999_999_999 };

const BASE_CTX: SenderContext = {
  user: { id: 'u1', email: 'pat@gmail.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Pat Lee — Personal', kind: 'PERSONAL' },
  workspace: 'personal',
  permissions: { read: true, create: true, send: true, templates: true },
  features: { templates: true },
  can_send: true,
  personal_sending_enabled: true,
  organization_url: null,
  app_home_url: null,
  personal_account_owner: true,
  template_plan: 'INCLUDED',
  template_studio: true,
  template_use_as_is: true,
};

const SUMMARY = {
  counts: { draft: 0, sent: 0, in_progress: 0, completed: 0, declined: 0, voided: 0, expired: 0 },
  awaiting_signatures: 0,
  completed_this_month: 0,
  declined_or_expired: 0,
  months: [],
  completion_rate: null,
  expiring_soon: [],
  signing_window_days: 7,
};

const DEFAULT_ID = 'aaaaaaaa-0000-7000-8000-000000000001';
const MINE_ID = 'bbbbbbbb-0000-7000-8000-000000000001';

const GALLERY = {
  items: [
    {
      template_id: DEFAULT_ID,
      name: 'Mutual NDA',
      description: 'Two-way confidentiality.',
      document_type: { id: 'd1', name: 'Non-disclosure agreement' },
      products: ['sign'],
      version_id: 'v1',
      version_number: 1,
      updated_at: '2026-11-01T00:00:00Z',
      adopted_template_id: null,
    },
  ],
};

const STUDIO_LIST = {
  items: [
    {
      id: MINE_ID,
      owner_scope: 'TENANT',
      document_type_id: 'd2',
      name: 'My lease',
      description: null,
      template_kind: 'GENERATED',
      status: 'ACTIVE',
      client_id: null,
      current_version_id: 'v9',
      current_version_number: 2,
      updated_at: '2026-11-01T00:00:00Z',
      products: null,
      withdraw_effective_at: null,
      configurable: true,
      adopted_template_id: null,
    },
  ],
  document_types: [],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function stub(ctx: SenderContext, extra: Handler = () => undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const hit = extra(url, init);
    if (hit !== undefined) return hit;
    if (url.includes('/auth/sign/session')) return json(SESSION);
    if (url.endsWith('/v1/sign/sender/context')) return json(ctx);
    if (url.endsWith('/v1/sign/sender/summary')) return json(SUMMARY);
    if (url.endsWith('/v1/sign/sender/templates/library')) return json(GALLERY);
    if (url.endsWith('/v1/sign/sender/templates/studio')) return json(STUDIO_LIST);
    return json({ items: [], counts: {} });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const calledWith = (m: ReturnType<typeof stub>, suffix: string): boolean => m.mock.calls.some(([u]) => String(u).endsWith(suffix));

describe('TEMPLATE-PRODUCT-1 §8 — Personal templates in Aramo Sign', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('§8.1 — the Personal navigation has Templates', async () => {
    stub(BASE_CTX);
    renderAt('/personal');
    const side = await screen.findByLabelText('Aramo Sign navigation');
    expect(within(side).getByRole('link', { name: /Templates/ })).toHaveAttribute('href', '/personal/templates');
  });

  it('§8.1 — while sign.templates is not available the page says Coming soon (no template call)', async () => {
    const m = stub({ ...BASE_CTX, features: { templates: false }, template_plan: null, template_studio: false, template_use_as_is: false });
    renderAt('/personal/templates');
    expect(await screen.findByTestId('templates-unavailable')).toHaveTextContent('Templates are coming soon');
    expect(calledWith(m, '/templates/library')).toBe(false);
  });

  it('§8.1 / P-6 — the Free plan gets an upgrade prompt and no templates', async () => {
    const m = stub({ ...BASE_CTX, template_plan: 'FREE_PLAN', template_studio: false, template_use_as_is: false });
    renderAt('/personal/templates');
    const prompt = await screen.findByTestId('templates-upgrade-prompt');
    expect(prompt).toHaveTextContent('Templates come with Personal Standard');
    expect(screen.getByTestId('templates-upgrade')).toHaveAttribute('href', '/personal/settings/billing');
    expect(calledWith(m, '/templates/library')).toBe(false);
    expect(calledWith(m, '/templates/studio')).toBe(false);
  });

  it('§8.2 — My templates and the Aramo (Sign) gallery, with Adopt and edit / Use as it is', async () => {
    stub(BASE_CTX);
    renderAt('/personal/templates');
    expect(await screen.findByTestId(`my-template-${MINE_ID}`)).toHaveTextContent('My lease');
    expect(screen.getByTestId(`my-template-${MINE_ID}`)).toHaveTextContent('In use · v2');
    expect(screen.getByTestId(`open-studio-${MINE_ID}`)).toHaveAttribute('href', `/personal/templates/studio/${MINE_ID}`);
    expect(screen.getByTestId(`use-template-${MINE_ID}`)).toHaveAttribute('href', `/personal/templates/${MINE_ID}/use`);
    expect(screen.getByTestId(`gallery-${DEFAULT_ID}`)).toHaveTextContent('Non-disclosure agreement · Sign');
    expect(screen.getByTestId(`adopt-${DEFAULT_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`use-as-is-${DEFAULT_ID}`)).toHaveTextContent('Use as it is');
    // A Personal account never sees the Org Home link.
    expect(screen.queryByTestId('manage-templates-link')).toBeNull();
  });

  it('§8.2 / §7.4 — My templates also lists the visible Aramo fixed forms tagged Sign: read-only, used as they are (never adopted or opened in the Studio)', async () => {
    const FORM_ID = 'cccccccc-0000-7000-8000-000000000001';
    stub(BASE_CTX, (url) =>
      url.endsWith('/v1/sign/sender/templates')
        ? json({
            items: [
              { template_id: FORM_ID, name: 'Employment eligibility form', description: null, document_type: { id: 'd3', key: 'I_9', name: 'I-9' }, owner_scope: 'PLATFORM', resolution: 'AVAILABLE', version_id: 'fv1', version_number: 1, updated_at: '2026-11-01T00:00:00Z', variables: [], template_kind: 'FIXED_FORM' },
              { template_id: MINE_ID, name: 'My lease', description: null, document_type: { id: 'd2', key: 'LEASE', name: 'Lease' }, owner_scope: 'TENANT', resolution: 'AVAILABLE', version_id: 'v9', version_number: 2, updated_at: '2026-11-01T00:00:00Z', variables: [] },
            ],
            unavailable: [],
          })
        : undefined,
    );
    renderAt('/personal/templates');
    const row = await screen.findByTestId(`my-form-${FORM_ID}`);
    expect(row).toHaveTextContent('Employment eligibility form');
    expect(row).toHaveTextContent('Aramo form · read-only · v1');
    expect(screen.getByTestId(`use-template-${FORM_ID}`)).toHaveAttribute('href', `/personal/templates/${FORM_ID}/use`);
    expect(screen.queryByTestId(`open-studio-${FORM_ID}`)).toBeNull();
    // The editable template from the same list is shown once (from the Studio list), never as a form.
    expect(screen.queryByTestId(`my-form-${MINE_ID}`)).toBeNull();
    expect(screen.getByTestId(`my-template-${MINE_ID}`)).toBeInTheDocument();
  });

  it('§8.5 — Use as it is is one POST adopt-and-use, then the lists reload', async () => {
    const m = stub(BASE_CTX, (url, init) =>
      url.endsWith(`/templates/library/${DEFAULT_ID}/adopt-and-use`) && init?.method === 'POST'
        ? json({ template: { id: 'new-1' }, version: { id: 'new-v1' } }, 201)
        : undefined,
    );
    renderAt('/personal/templates');
    fireEvent.click(await screen.findByTestId(`use-as-is-${DEFAULT_ID}`));
    await waitFor(() => expect(calledWith(m, `/templates/library/${DEFAULT_ID}/adopt-and-use`)).toBe(true));
    await waitFor(() => expect(m.mock.calls.filter(([u]) => String(u).endsWith('/templates/library')).length).toBe(2));
  });

  it('§8.5 — a refusal for lack of approval reads "Ask an admin to approve this template"', async () => {
    stub(BASE_CTX, (url) =>
      url.endsWith('/adopt-and-use')
        ? json({ error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Only an admin can approve a template', details: { reason: 'template_approval_required' } } }, 403)
        : undefined,
    );
    renderAt('/personal/templates');
    fireEvent.click(await screen.findByTestId(`use-as-is-${DEFAULT_ID}`));
    expect(await screen.findByText(ASK_ADMIN)).toBeInTheDocument();
  });

  it('§8.5 — without approval the gallery offers Adopt and edit only', async () => {
    stub({ ...BASE_CTX, template_use_as_is: false });
    renderAt('/personal/templates');
    expect(await screen.findByTestId(`adopt-${DEFAULT_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`use-as-is-${DEFAULT_ID}`)).toBeNull();
  });

  it('§8.2 — Adopt and edit adopts through Sign and opens the new draft in the Studio route', async () => {
    const m = stub(BASE_CTX, (url, init) =>
      url.endsWith('/templates/studio/adopt') && init?.method === 'POST' ? json({ template: { id: 'adopted-1' }, version: { id: 'adv1' } }, 201) : undefined,
    );
    renderAt('/personal/templates');
    fireEvent.click(await screen.findByTestId(`adopt-${DEFAULT_ID}`));
    await waitFor(() => expect(calledWith(m, '/templates/studio/adopt')).toBe(true));
    const body = m.mock.calls.find(([u]) => String(u).endsWith('/templates/studio/adopt'))?.[1]?.body;
    expect(JSON.parse(String(body))).toEqual({ library_template_id: DEFAULT_ID });
  });
});

describe('TEMPLATE-PRODUCT-1 §8.2–8.3 — the Personal Studio data source and copy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('"Approve" is "Use this version" and the crumb is Templates', () => {
    const copy = personalStudioCopy('/personal/templates');
    expect(copy.approveButton(3, true)).toBe('Use this version (v3)…');
    expect(copy.approveDialog.commit(3)).toBe('Use this version (v3)');
    expect(copy.crumbs).toEqual([{ label: 'Templates', to: '/personal/templates' }]);
    expect(copy.versionActive.label).toBe('In use');
  });

  it('runs the shared organization source over the Sign Studio routes (Sign stores nothing)', async () => {
    const m = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/v1/sign/sender/templates/studio/${MINE_ID}`)) return json({ ...STUDIO_LIST.items[0], tenant_id: 't1', created_at: '2026-11-01T00:00:00Z' });
      if (url.endsWith(`/v1/sign/sender/templates/studio/${MINE_ID}/versions`)) return json([]);
      return json({});
    });
    vi.stubGlobal('fetch', m);
    const src = personalStudioDataSource({ listHref: '/personal/templates', canEdit: true });
    expect(src.capabilities).toMatchObject({ canEdit: true, canApprove: true, canWithdraw: false });
    expect(src.sections).toBeUndefined();
    const t = await src.load(MINE_ID);
    expect(t.name).toBe('My lease');
    const urls = m.mock.calls.map(([u]) => String(u));
    expect(urls.every((u) => u.includes('/v1/sign/sender/templates/studio/'))).toBe(true);
    expect(urls.some((u) => u.includes('/v1/document-templates'))).toBe(false);
  });

  it('read-only when the person cannot author', () => {
    const src = personalStudioDataSource({ listHref: '/personal/templates', canEdit: false });
    expect(src.capabilities).toMatchObject({ canEdit: false, canApprove: false });
  });
});
