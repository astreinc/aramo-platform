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
    expect(within(denied).getByText('Super admin')).toBeInTheDocument();
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
    expect(labels).toEqual(['Request retire…']);
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
    expect(create?.body).toMatchObject({ action_type: 'PLAN_VERSION_PUBLISH', payload: { plan_version_id: 'team-3', evidence: 'PR-2026-Q4' }, reason: 'Annual price review' });
    expect((create?.body as { idempotency_key: string }).idempotency_key).toMatch(/^catalog-/);
    // The console never publishes, retires or applies a version itself.
    expect(calls.filter((c) => /publish|retire|apply/i.test(new URL(c.url, 'http://x').pathname))).toEqual([]);
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${new URL(c.url, 'http://x').pathname}`)).toEqual([
      'POST /platform/commercial/change-requests',
      'POST /platform/commercial/change-requests/019a0000-0000-7000-8000-00000000c001/submit',
    ]);
  });

  it('B2-W-RETIRE Request retire… needs the typed plan name and creates a PLAN_RETIRE change request', async () => {
    mockApi('catalog_manager');
    renderAt(`/commercial/catalog?plan=${TEAM.id}&version=2`);
    fireEvent.click(await screen.findByRole('button', { name: 'Request retire…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request retire · Sign Team v2' });
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
    expect(screen.getByLabelText('Seats')).toBeDisabled();
    fireEvent.change(price, { target: { value: '72' } });
    fireEvent.blur(price);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(new URL(patch!.url, 'http://x').pathname).toBe('/platform/commercial/catalog/versions/team-3');
    expect(patch?.body).toEqual({ expected_content_checksum: 'c'.repeat(64), list_price_minor: 7200 });
  });

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
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/apply'))).toBe(true));
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${new URL(c.url, 'http://x').pathname}`)).toEqual([
      'POST /platform/commercial/change-requests/019a0000-0000-7000-8000-00000000c002/apply',
    ]);
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
