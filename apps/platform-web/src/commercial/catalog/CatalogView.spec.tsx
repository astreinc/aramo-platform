import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../App';
import { platformSession } from '../../skills/test-session';

import { CATALOG, ROLE_SCOPES, TEAM } from './catalog-test-data';
import type { Catalog } from './catalog-api';

// CCP-B2 (Program Build Directive §5.3 row B2) — the Catalog screen through the REAL console
// route gate (App → PlatformConsole → gate(platform:catalog:read)), with fetch answered here:
//   - per-role visibility for the 6 CCP roles and super_admin (in-shell access denied);
//   - published versions are read-only: no enabled field and no edit action on them;
//   - publish only through the chain: "Request publish…" creates a PLAN_VERSION_PUBLISH change
//     request and submits it — there is no publish call; retire likewise, with typed confirm;
//   - a catalog manager's DRAFT edit is saved by PATCH when the field loses focus.

type Call = { method: string; url: string; body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('CCP-B2 Catalog screen', () => {
  let calls: Call[];
  const realLocation = window.location;

  let failCatalog = false;
  let hangCatalog = false;
  // CCP-A6-R (TD-B2-3): the request read's apply_actionable for the caller.
  let applyActionable = true;
  function mockApi(role: string, catalog: Catalog = CATALOG) {
    calls = [];
    failCatalog = false;
    hangCatalog = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, body });
      if (url.includes('/auth/platform/session')) return json(platformSession([...(ROLE_SCOPES[role] ?? [])]));
      if (url.includes('/platform/me')) return json({ user_id: 'u1', email: 'lena.fischer@aramo.ai', display_name: 'Lena Fischer', tenant_id: 't', tenant_name: 'Aramo Platform', role_keys: [role] });
      if (url.endsWith('/platform/commercial/catalog') && method === 'GET') {
        if (hangCatalog) return new Promise<Response>(() => undefined);
        return failCatalog ? json({ error: { code: 'INTERNAL', message: 'The catalog is unavailable.' } }, 500) : json(catalog);
      }
      if (/\/platform\/commercial\/catalog\/versions\/[^/]+$/.test(url) && method === 'GET') {
        return json({ version: TEAM.versions[1], plan: TEAM, content: {}, pinned_tenants: [{ tenant_id: 't1', name: 'Northwind Logistics' }] });
      }
      if (/\/platform\/commercial\/catalog\/versions\/[^/]+$/.test(url) && method === 'PATCH') return json({ version: TEAM.versions[0] });
      if (url.endsWith('/drafts') && method === 'POST') return json({ version: { ...TEAM.versions[0], version_number: 4 } }, 201);
      if (url.endsWith('/platform/commercial/change-requests') && method === 'POST') {
        return json({ request: { id: '019a0000-0000-7000-8000-00000000c001', action_type: (body as { action_type: string }).action_type, state: 'DRAFT', required_chain: { rule: 'FINANCE_THEN_OWNER', steps: [] }, policy_version_id: 'pol-1' }, replayed: false }, 201);
      }
      if (/\/platform\/commercial\/change-requests\/[^/]+$/.test(url) && method === 'GET') return json({ apply_actionable: applyActionable });
      if (url.endsWith('/apply') && method === 'POST') {
        // TD-A6-13: the A6 apply route (mocked; the B2 base predates A6).
        return json({ request: { id: '019a0000-0000-7000-8000-00000000c002', action_type: 'PLAN_VERSION_PUBLISH', state: 'APPLIED', required_chain: { rule: 'FINANCE_THEN_OWNER', steps: [] }, policy_version_id: 'pol-1' } });
      }
      if (url.endsWith('/submit') && method === 'POST') {
        return json({ request: { id: '019a0000-0000-7000-8000-00000000c001', action_type: 'PLAN_VERSION_PUBLISH', state: 'PENDING_APPROVAL', required_chain: { rule: 'FINANCE_THEN_OWNER', steps: [{ step_index: 0, role_key: 'finance_admin' }, { step_index: 1, role_key: 'platform_owner' }] }, policy_version_id: 'pol-1' } });
      }
      return json({}, 404);
    });
  }

  function renderAt(path: string) {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    applyActionable = true;
    configureAuthConsumer('platform');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, assign: vi.fn(), pathname: '/commercial/catalog', search: '', hash: '', origin: 'http://localhost' },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    configureAuthConsumer('recruiter');
  });

  const ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;

  for (const role of ROLES) {
    it(`B2-W-ROLE ${role}: sees the catalog; ${role === 'catalog_manager' ? 'no view-only note and enabled draft actions' : 'the view-only note and every action disabled with the reason'}`, async () => {
      mockApi(role);
      renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
      expect(await screen.findByRole('heading', { level: 1, name: 'Catalog' })).toBeInTheDocument();
      await screen.findByText('Sign Team v3');
      const note = screen.queryByRole('note');
      const publish = screen.getByRole('button', { name: 'Request publish…' });
      if (role === 'catalog_manager') {
        expect(note).toBeNull();
        expect(publish).toBeEnabled();
      } else {
        expect(note).toHaveTextContent('View only. You can view the catalog. Drafting, publishing and retiring versions needs the Catalog manager role.');
        expect(publish).toBeDisabled();
        expect(publish).toHaveAttribute('title', 'Needs the Catalog manager role.');
        // The draft's fields are read-only too.
        for (const input of within(screen.getByTestId('version-editor')).getAllByRole('spinbutton')) expect(input).toBeDisabled();
      }
      expect(screen.queryByTestId('access-denied')).toBeNull();
    });
  }

  it('B2-W-ROLE super_admin: the in-shell access denied names the page and the catalog read permission; no catalog call', async () => {
    mockApi('super_admin');
    renderAt('/commercial/catalog');
    const denied = await screen.findByTestId('access-denied');
    // Merge train (TD-B2-7): the Commercial access-denied card of CCP-B1 (handoff §2).
    expect(within(denied).getByRole('heading', { level: 1 })).toHaveTextContent("This account can't open Commercial catalog");
    // The role label arrives with the async /platform/me read; wait for it (was a load-dependent race).
    expect(await within(denied).findByText('Super admin')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/platform/commercial/catalog'))).toBe(false);
  });

  it('B2-W-RO a PUBLISHED version is read-only even for a catalog manager: every field disabled, the immutability line, no edit action', async () => {
    mockApi('catalog_manager');
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=2`);
    await screen.findByText('Sign Team v2');
    const editor = screen.getByTestId('version-editor');
    expect(within(editor).getByText(/Published versions are immutable\. To change pricing or allowances, create a new draft\./)).toBeInTheDocument();
    for (const input of within(editor).getAllByRole('spinbutton')) expect(input).toBeDisabled();
    for (const input of within(editor).getAllByRole('textbox')) expect(input).toBeDisabled();
    const labels = within(editor).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Retire this version…']);
    expect(labels.join(' ')).not.toMatch(/edit|save/i);
    expect(await within(editor).findByText('Northwind Logistics')).toBeInTheDocument();
    // Blurring a disabled field never sends a write.
    fireEvent.blur(within(editor).getAllByRole('spinbutton')[0]!);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('B2-W-CHAIN publish only through the chain: Request publish… → POST change-requests (PLAN_VERSION_PUBLISH) → POST submit; no publish route is ever called', async () => {
    mockApi('catalog_manager');
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
    fireEvent.click(await screen.findByRole('button', { name: 'Request publish…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request publish · Sign Team v3' });
    expect(within(dialog).getByTestId('chain-preview')).toHaveTextContent('Approval chainCatalog publishFinance → Ownerpolicy v1 · 72 h window');
    const commit = within(dialog).getByRole('button', { name: 'Submit for approval' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Annual price review' } });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Evidence'), { target: { value: 'PR-2026-Q4' } });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/submit'))).toBe(true));
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/platform/commercial/change-requests'));
    expect(create?.body).toMatchObject({ action_type: 'PLAN_VERSION_PUBLISH', payload: { plan_version_id: 'team-3' }, reason: 'Annual price review\n\nEvidence: PR-2026-Q4' });
    expect((create?.body as { payload: Record<string, unknown> }).payload).not.toHaveProperty('evidence');
    expect((create?.body as { idempotency_key: string }).idempotency_key).toMatch(/^catalog-/);
    // The console never publishes, retires or applies a version itself.
    expect(calls.filter((c) => /publish|retire|apply/i.test(new URL(c.url, 'http://x').pathname))).toEqual([]);
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${new URL(c.url, 'http://x').pathname}`)).toEqual([
      'POST /platform/commercial/change-requests',
      'POST /platform/commercial/change-requests/019a0000-0000-7000-8000-00000000c001/submit',
    ]);
  });

  it('B2-W-RETIRE Retire this version… needs the typed plan name and creates a PLAN_RETIRE change request', async () => {
    mockApi('catalog_manager');
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=2`);
    fireEvent.click(await screen.findByRole('button', { name: 'Retire this version…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retire this version · Sign Team v2' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Replaced by v3' } });
    fireEvent.change(within(dialog).getByLabelText('Evidence'), { target: { value: 'PR-2026-Q4' } });
    const commit = within(dialog).getByRole('button', { name: 'Submit for approval' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'Team v2' } });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/submit'))).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/change-requests'))?.body).toMatchObject({ action_type: 'PLAN_RETIRE', payload: { plan_version_id: 'team-2' } });
  });

  it('B2-W-EDIT a catalog manager edits a DRAFT price; the PATCH carries the read checksum and only that term', async () => {
    mockApi('catalog_manager');
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
    await screen.findByText('Sign Team v3');
    const price = screen.getByLabelText('Price per month (USD)');
    expect(price).toBeEnabled();
    // Per-seat directive §3.4 (closes DV-B2-03): the former read-only Seats field is the "Priced per seat" toggle.
    expect(screen.queryByLabelText('Seats')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Priced per seat' })).toBeEnabled();
    fireEvent.change(price, { target: { value: '72' } });
    fireEvent.blur(price);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(new URL(patch!.url, 'http://x').pathname).toBe('/platform/commercial/catalog/versions/team-3');
    expect(patch?.body).toEqual({ expected_content_checksum: 'c'.repeat(64), list_price_minor: 7200 });
  });

  // Sign Business per-seat directive §3.4: "Priced per seat" on a DRAFT of a BUSINESS self-service plan.
  describe('per-seat pricing unit', () => {
    const withTeam = (over: Partial<typeof TEAM>): Catalog => ({ ...CATALOG, products: [{ product_key: 'sign', plans: [{ ...TEAM, ...over }] }] });

    it('PS-W-1 a catalog manager turns on per-seat pricing on a BUSINESS DRAFT; the PATCH carries the read checksum and only price_unit', async () => {
      mockApi('catalog_manager');
      renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
      await screen.findByText('Sign Team v3');
      const toggle = screen.getByRole('checkbox', { name: 'Priced per seat' });
      expect(toggle).not.toBeChecked();
      expect(screen.getByText('Pricing unit')).toBeInTheDocument();
      fireEvent.click(toggle);
      await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(new URL(patch!.url, 'http://x').pathname).toBe('/platform/commercial/catalog/versions/team-3');
      expect(patch?.body).toEqual({ expected_content_checksum: 'c'.repeat(64), price_unit: 'SEAT' });
    });

    it('PS-W-2 turning it off on a per-seat DRAFT sends ACCOUNT; the diff reads Per organization → Per seat', async () => {
      const seatDraft = { ...TEAM.versions[0]!, terms: { ...TEAM.versions[0]!.terms, price_unit: 'SEAT' as const } };
      mockApi('catalog_manager', withTeam({ versions: [seatDraft, ...TEAM.versions.slice(1)] }));
      renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
      await screen.findByText('Sign Team v3');
      const row = screen.getByText('Pricing unit').closest('[role="row"]') as HTMLElement;
      expect(within(row).getByText('Per organization')).toBeInTheDocument();
      expect(within(row).getByText('Per seat')).toBeInTheDocument();
      const toggle = screen.getByRole('checkbox', { name: 'Priced per seat' });
      expect(toggle).toBeChecked();
      fireEvent.click(toggle);
      await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ expected_content_checksum: 'c'.repeat(64), price_unit: 'ACCOUNT' });
    });

    it('PS-W-3 read-only on a PUBLISHED version and for a role without catalog:draft; never sends a PATCH', async () => {
      mockApi('catalog_manager');
      renderAt(`/commercial/catalog?plan=${TEAM.id}&version=2`);
      await screen.findByText('Sign Team v2');
      const toggle = screen.getByRole('checkbox', { name: 'Priced per seat' });
      expect(toggle).toBeDisabled();
      fireEvent.click(toggle);
      expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    });

    it('PS-W-4 hidden for a PERSONAL plan (no toggle, no Pricing unit diff row)', async () => {
      mockApi('catalog_manager', withTeam({ tenant_kind: 'PERSONAL' }));
      renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
      await screen.findByText('Sign Team v3');
      expect(screen.queryByRole('checkbox', { name: 'Priced per seat' })).toBeNull();
      expect(screen.queryByText('Pricing unit')).toBeNull();
    });

    it('PS-W-5 view-only role: disabled on a DRAFT', async () => {
      mockApi('finance_admin');
      renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
      await screen.findByText('Sign Team v3');
      expect(screen.getByRole('checkbox', { name: 'Priced per seat' })).toBeDisabled();
    });
  });

  // Sign Feature Parity Amendment A4 (D2): add-on unit prices are draft content edited by the catalog role only.
  const UNITS = [
    { unit_key: 'sign.sms_message', name: 'SMS delivery', quantity_label: 'message' },
    { unit_key: 'sign.id_verification', name: 'ID verification', quantity_label: 'verification' },
  ];
  const PRICED: Catalog = {
    ...CATALOG,
    metered_units: [{ product_key: 'sign', units: UNITS }],
    products: [
      {
        product_key: 'sign',
        plans: [
          {
            ...TEAM,
            versions: TEAM.versions.map((x) => (x.status === 'PUBLISHED' ? { ...x, terms: { ...x.terms, unit_prices: [{ unit_key: 'sign.sms_message', unit_price_minor: 36 }] } } : x)),
          },
        ],
      },
    ],
  };

  it('A4-W-1 a catalog manager prices an add-on on a DRAFT; the PATCH carries the read checksum and only that unit price (cents); the diff shows the change', async () => {
    mockApi('catalog_manager', PRICED);
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
    await screen.findByText('Sign Team v3');
    const box = screen.getByTestId('unit-prices');
    const sms = within(box).getByLabelText('SMS delivery unit price');
    expect(sms).toBeEnabled();
    expect(sms).toHaveValue('');
    expect(screen.getByText('Add-on · SMS delivery')).toBeInTheDocument();
    fireEvent.change(sms, { target: { value: '0.05' } });
    fireEvent.blur(sms);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(new URL(patch!.url, 'http://x').pathname).toBe('/platform/commercial/catalog/versions/team-3');
    expect(patch?.body).toEqual({ expected_content_checksum: 'c'.repeat(64), unit_prices: { 'sign.sms_message': 5 } });
  });

  it('A4-W-2 an invalid add-on price is flagged and never sent; clearing a price sends null (not sold)', async () => {
    mockApi('catalog_manager', PRICED);
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
    await screen.findByText('Sign Team v3');
    const id = within(screen.getByTestId('unit-prices')).getByLabelText('ID verification unit price');
    fireEvent.change(id, { target: { value: '1.505' } });
    fireEvent.blur(id);
    expect(id).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    fireEvent.change(id, { target: { value: '' } });
    fireEvent.blur(id);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ expected_content_checksum: 'c'.repeat(64), unit_prices: { 'sign.id_verification': null } });
  });

  it('A4-W-3 a PUBLISHED version shows its approved add-on prices read-only, even for a catalog manager', async () => {
    mockApi('catalog_manager', PRICED);
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=2`);
    await screen.findByText('Sign Team v2');
    const sms = within(screen.getByTestId('unit-prices')).getByLabelText('SMS delivery unit price');
    expect(sms).toHaveValue('0.36');
    expect(sms).toBeDisabled();
    fireEvent.blur(sms);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  for (const role of ['finance_admin', 'platform_owner', 'commercial_ops']) {
    it(`A4-W-4 ${role} cannot edit add-on prices on a DRAFT (view only)`, async () => {
      mockApi(role, PRICED);
      renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
      await screen.findByText('Sign Team v3');
      for (const input of within(screen.getByTestId('unit-prices')).getAllByRole('textbox')) {
        expect(input).toBeDisabled();
        fireEvent.change(input, { target: { value: '9' } });
        fireEvent.blur(input);
      }
      expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    });
  }

  it('B2-W-PRODUCTS ATS, Portal and Intelligence have no plans: the dashed entitlement-only card', async () => {
    mockApi('read_only_auditor');
    renderAt('/commercial/catalog?product=portal');
    expect(await screen.findByText('Portal is granted as an entitlement only. Plans appear here once pricing is decided.')).toBeInTheDocument();
    const products = screen.getByRole('group', { name: 'Products' });
    expect(within(products).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Aramo Sign2 plans',
      'ATSNo commercial plans yet — pricing not set',
      'PortalNo commercial plans yet — pricing not set',
      'IntelligenceNo commercial plans yet — pricing not set',
    ]);
  });

  it('B2-W-APPLY (TD-A6-13) an APPROVED publish request is executed through POST /change-requests/{id}/apply — never a catalog publish call', async () => {
    const approved = { id: '019a0000-0000-7000-8000-00000000c002', action_type: 'PLAN_VERSION_PUBLISH' as const, state: 'APPROVED', expires_at: null };
    const draft = { ...TEAM.versions[0]!, open_requests: [approved] };
    const cat: Catalog = { ...CATALOG, products: [{ product_key: 'sign', plans: [{ ...TEAM, versions: [draft, ...TEAM.versions.slice(1)] }] }] };
    mockApi('platform_owner', cat);
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
    expect(await screen.findByTestId('open-request')).toHaveTextContent('Publish request 019a000… is approved.');
    expect(screen.getByRole('button', { name: 'Request publish…' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/apply'))).toBe(true));
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${new URL(c.url, 'http://x').pathname}`)).toEqual([
      'POST /platform/commercial/change-requests/019a0000-0000-7000-8000-00000000c002/apply',
    ]);
  });

  it('B2-W-APPLY-2 (TD-B2-3, merge train TD-MERGE-9) no Apply action when the request read says this caller may not apply it', async () => {
    applyActionable = false;
    const approved = { id: '019a0000-0000-7000-8000-00000000c002', action_type: 'PLAN_VERSION_PUBLISH' as const, state: 'APPROVED', expires_at: null };
    const draft = { ...TEAM.versions[0]!, open_requests: [approved] };
    const cat: Catalog = { ...CATALOG, products: [{ product_key: 'sign', plans: [{ ...TEAM, versions: [draft, ...TEAM.versions.slice(1)] }] }] };
    mockApi('platform_owner', cat);
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=3`);
    expect(await screen.findByTestId('open-request')).toHaveTextContent('Publish request 019a000… is approved.');
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/change-requests/019a0000-0000-7000-8000-00000000c002'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  // CCP PLAN_CREATE (catalog row 17) — "New plan…" creates a PLAN_CREATE change request and submits it;
  // the console never creates a plan. Only AVAILABLE capabilities are offered.
  const WITH_CREATE: Catalog = {
    ...CATALOG,
    plan_create: {
      available_keys: [{ product_key: 'sign', keys: ['sign.envelopes', 'sign.in_person_signing', 'sign.storage_bytes', 'sign.team_collaboration'] }],
      pending: [
        { id: '019a0000-0000-7000-8000-00000000c0c1', plan_key: 'aramo-sign-pro-v2', name: 'Pro', product_key: 'sign', tenant_kind: 'BUSINESS', sales_model: 'SELF_SERVICE', state: 'APPROVED', requested_by: '01900000-0000-7000-8000-0000000ac001', expires_at: null },
      ],
    },
  };

  it('PC-W-NEW a catalog manager requests a new plan: New plan… → POST change-requests (PLAN_CREATE, the whole plan, only available features) → POST submit; no catalog write', async () => {
    mockApi('catalog_manager', WITH_CREATE);
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=2`);
    fireEvent.click(await screen.findByRole('button', { name: 'New plan…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New plan · Aramo Sign' });
    expect(within(dialog).getByTestId('chain-preview')).toHaveTextContent('Finance → Owner');
    const features = within(dialog).getByRole('group', { name: 'Features' });
    expect(within(features).getAllByRole('checkbox')).toHaveLength(2);
    expect(features).not.toHaveTextContent(/templates/i);
    const commit = within(dialog).getByRole('button', { name: 'Submit for approval' });
    fireEvent.change(within(dialog).getByLabelText('Plan key'), { target: { value: 'aramo-sign-starter-v1' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Starter' } });
    fireEvent.change(within(dialog).getByLabelText('Price per month (USD)'), { target: { value: '9' } });
    fireEvent.change(within(dialog).getByLabelText('Envelopes per month'), { target: { value: '50' } });
    fireEvent.click(within(features).getByLabelText('Team collaboration'));
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Entry tier' } });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Evidence'), { target: { value: 'PRICING-2026-11' } });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/submit'))).toBe(true));
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/platform/commercial/change-requests'));
    expect(create?.body).toMatchObject({
      action_type: 'PLAN_CREATE',
      payload: {
        plan_key: 'aramo-sign-starter-v1',
        product_key: 'sign',
        sales_model: 'SELF_SERVICE',
        name: 'Starter',
        list_price_minor: 900,
        allowances: [{ allowance_key: 'sign.envelopes', included_quantity: 50, unlimited: false, period: 'MONTHLY' }],
        features: [
          { feature_key: 'sign.in_person_signing', enabled: false },
          { feature_key: 'sign.team_collaboration', enabled: true },
        ],
      },
      reason: 'Entry tier\n\nEvidence: PRICING-2026-11',
    });
    expect(create).not.toHaveProperty('body.tenant_id');
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${new URL(c.url, 'http://x').pathname}`)).toEqual([
      'POST /platform/commercial/change-requests',
      'POST /platform/commercial/change-requests/019a0000-0000-7000-8000-00000000c001/submit',
    ]);
  });

  it('PC-W-PENDING the pending creation is listed; its requester applies the approved request through the apply route; other roles see New plan… disabled', async () => {
    mockApi('catalog_manager', WITH_CREATE);
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=2`);
    const pending = await screen.findByTestId('pending-plan-creates');
    expect(pending).toHaveTextContent('Pro (aramo-sign-pro-v2) · approved, waiting to be applied');
    fireEvent.click(within(pending).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/apply'))).toBe(true));
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${new URL(c.url, 'http://x').pathname}`)).toEqual([
      'POST /platform/commercial/change-requests/019a0000-0000-7000-8000-00000000c0c1/apply',
    ]);
  });

  it('PC-W-ROLE a finance admin sees New plan… disabled with the reason, and no Apply action', async () => {
    mockApi('finance_admin', WITH_CREATE);
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=2`);
    const btn = await screen.findByRole('button', { name: 'New plan…' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Needs the Catalog manager role.');
    // Apply is the requester's (TD-B2-3) and needs the requester scope; without it no Apply is offered.
    expect(within(await screen.findByTestId('pending-plan-creates')).queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('B2-W-LOAD a failed read shows the error with Try again, which reloads the catalog', async () => {
    mockApi('read_only_auditor');
    failCatalog = true;
    renderAt('/commercial/catalog');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The catalog is unavailable.');
    failCatalog = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Sign Team')).toBeInTheDocument();
  });

  it('B2-W-SKELETON while the catalog loads, the skeleton panels show', async () => {
    mockApi('read_only_auditor');
    hangCatalog = true;
    renderAt('/commercial/catalog');
    expect(await screen.findByText('Loading the catalog…')).toBeInTheDocument();
    expect(screen.getByText('Loading plans…')).toBeInTheDocument();
  });
});
