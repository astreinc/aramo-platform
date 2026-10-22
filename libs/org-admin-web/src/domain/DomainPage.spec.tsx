import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { stubFetch, type StubCall } from '../tests/fetch-stub';

import type { DomainVerificationView } from './domain-api';
import { DomainPage } from './DomainPage';

// ORG-UX-1 §8.6 / §13.4 / handoff §6.6 — Domain against the P3 services only.

const BASE: DomainVerificationView = {
  status: 'UNVERIFIED',
  allowed_domain: 'acme.test',
  record_name: null,
  record_value: null,
  verified_at: null,
  token_issued_at: null,
  domain_claim: 'PROVISIONAL',
  domain_claim_conflict: false,
};
const PENDING: DomainVerificationView = { ...BASE, status: 'PENDING', record_name: '_aramo-verify.acme.test', record_value: 'aramo-verify=abc123', token_issued_at: '2026-10-20T00:00:00Z' };
const NOTE = 'DNS changes can take minutes to hours. Verification proves domain ownership and is required before self-service Sign activation; it doesn’t change who can sign in.';

function renderPage() {
  return render(
    <ToastProvider>
      <DomainPage />
    </ToastProvider>,
  );
}

const DLG = { id: '11111111-1111-4111-8111-111111111111', delegate_email: 'it@acme.test', expires_at: '2026-10-29T00:00:00Z', created_at: '2026-10-22T00:00:00Z', last_used_at: null, revoked_at: null };

function domainStub(initial: DomainVerificationView, extra?: (c: StubCall) => { status?: number; body?: unknown } | undefined) {
  return stubFetch((c) => {
    const hit = extra?.(c);
    if (hit !== undefined) return hit;
    if (c.url.endsWith('/delegations') && c.method === 'GET') return { body: { items: [] } };
    if (c.url === '/v1/tenant/domain-verification' && c.method === 'GET') return { body: initial };
    return undefined;
  });
}

describe('DomainPage', () => {
  it.each([
    ['UNVERIFIED', 'Not verified', 'ox-pill--warn'],
    ['PENDING', 'Checking…', 'ox-pill--invited'],
    ['VERIFIED', 'Verified', 'ox-pill--active'],
  ] as const)('maps %s to the "%s" pill', async (status, label, cls) => {
    domainStub(status === 'PENDING' ? PENDING : { ...BASE, status, domain_claim: status === 'VERIFIED' ? 'AUTHORITATIVE' : 'PROVISIONAL' });
    renderPage();
    const pill = await screen.findByTestId('domain-status');
    expect(pill).toHaveTextContent(label);
    expect(pill).toHaveClass(cls);
  });

  it('with no record yet shows "Get TXT record" first, which POSTs and then shows the steps', async () => {
    const calls = domainStub(BASE, (c) => (c.method === 'POST' && c.url === '/v1/tenant/domain-verification' ? { body: PENDING } : undefined));
    renderPage();
    const get = await screen.findByTestId('domain-request');
    expect(get).toHaveTextContent('Get TXT record');
    expect(screen.queryByText('1 · Add this TXT record at your DNS provider')).toBeNull();
    expect(screen.getByText(/Prove you control/)).toHaveTextContent('Prove you control acme.test by publishing a DNS TXT record.');
    expect(screen.getByTestId('domain-note')).toHaveTextContent(NOTE);
    fireEvent.click(get);
    expect(await screen.findByText('1 · Add this TXT record at your DNS provider')).toBeInTheDocument();
    expect(screen.getByText('2 · Check the record')).toBeInTheDocument();
    expect(screen.getByTestId('domain-record-name')).toHaveTextContent('_aramo-verify.acme.test');
    expect(screen.getByTestId('domain-record-value')).toHaveTextContent('aramo-verify=abc123');
    expect(screen.getByRole('button', { name: 'Copy name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy value' })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/tenant/domain-verification')).toBe(true);
  });

  it('Check now reads "Checking…" and is disabled while checking, then shows Verified', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let checked = false;
    stubFetch((c) => {
      if (c.url.endsWith('/delegations')) return { body: { items: [] } };
      if (c.url.endsWith('/check')) {
        checked = true;
        return { body: { ...PENDING, status: 'VERIFIED', domain_claim: 'AUTHORITATIVE', verified_at: '2026-10-22T00:00:00Z' } };
      }
      if (c.url === '/v1/tenant/domain-verification') return { body: PENDING };
      return undefined;
    });
    // Hold the check response until we've observed the busy state.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/check')) await gate;
      return original(input, init);
    }) as typeof fetch;
    try {
      renderPage();
      const btn = await screen.findByTestId('domain-check');
      expect(btn).toHaveTextContent('Check now');
      fireEvent.click(btn);
      await waitFor(() => expect(screen.getByTestId('domain-check')).toHaveTextContent('Checking…'));
      expect(screen.getByTestId('domain-check')).toBeDisabled();
      release?.();
      await waitFor(() => expect(screen.getByTestId('domain-status')).toHaveTextContent('Verified'));
      expect(checked).toBe(true);
      expect(screen.getByTestId('domain-authoritative')).toHaveTextContent('Your organization is the verified owner of acme.test on Aramo');
      expect(screen.getByTestId('domain-claim')).toHaveTextContent('Authoritative');
      expect(screen.queryByTestId('domain-delegation')).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('shows the P3 claim state and the conflict alert', async () => {
    domainStub({ ...PENDING, domain_claim: 'LAPSED', domain_claim_conflict: true });
    renderPage();
    expect(await screen.findByTestId('domain-claim')).toHaveTextContent('Lapsed');
    expect(screen.getByTestId('domain-claim-lapsed')).toBeInTheDocument();
    expect(screen.getByTestId('domain-conflict')).toHaveTextContent('Another Aramo organization holds this domain. Contact Aramo support.');
  });

  it('delegation: lists, issues (POST delegate_email) and revokes (DELETE by id)', async () => {
    let listed = [DLG];
    const calls = stubFetch((c) => {
      if (c.url.endsWith('/delegations') && c.method === 'GET') return { body: { items: listed } };
      if (c.url.endsWith('/delegations') && c.method === 'POST') {
        const created = { ...DLG, id: '22222222-2222-4222-8222-222222222222', delegate_email: 'ops@acme.test' };
        listed = [...listed, created];
        return { status: 201, body: created };
      }
      if (c.method === 'DELETE') return { body: { ...DLG, revoked_at: '2026-10-22T01:00:00Z' } };
      if (c.url === '/v1/tenant/domain-verification') return { body: PENDING };
      return undefined;
    });
    renderPage();
    const panel = await screen.findByTestId('domain-delegation');
    expect(await within(panel).findByText('it@acme.test')).toBeInTheDocument();

    const send = within(panel).getByTestId('domain-delegate');
    expect(send).toBeDisabled();
    fireEvent.change(within(panel).getByTestId('domain-delegate-email'), { target: { value: 'ops@acme.test' } });
    fireEvent.click(send);
    expect(await within(panel).findByText('ops@acme.test')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/delegations'))?.body).toEqual({ delegate_email: 'ops@acme.test' });

    fireEvent.click(within(panel).getByTestId(`domain-revoke-${DLG.id}`));
    await waitFor(() => expect(within(panel).queryByText('it@acme.test')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/delegations/${DLG.id}`))).toBe(true);
  });

  it('renders the PLANNED single sign-on card with no controls', async () => {
    domainStub(BASE);
    renderPage();
    const card = await screen.findByTestId('domain-sso-planned');
    expect(card).toHaveTextContent('Single sign-on & sign-in policy');
    expect(card).toHaveTextContent('PLANNED');
    expect(within(card).getAllByRole('listitem')).toHaveLength(3);
    expect(within(card).queryByRole('button')).toBeNull();
  });
});
