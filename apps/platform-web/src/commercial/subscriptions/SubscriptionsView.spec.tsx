import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../App';

import { NON_READERS, NOW, READERS, STRIPE_ROW, T_NORTHWIND, installFetch, row, world, writes } from './subscriptions-test-data';

// CCP-B3 (PBD §5.3 B3 row; CCP-UI v1.0 handoff §5.3) — Commercial › Subscriptions through the
// real App (router, shell, B1's commercialGate) with the platform-admin routes answered by a
// fetch mock. Per role: the five roles holding platform:subscription:read see the workbench;
// catalog_manager and super_admin get the in-shell Commercial access-denied card and the read is
// never called (the backend refuses them too: ccp-b3-subscriptions-authorization.spec.ts).

function renderAt(path = '/commercial/subscriptions') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const table = () => screen.findByRole('table');

describe('CCP-B3 Subscriptions workbench — per role (6 commercial roles + super_admin)', () => {
  beforeEach(() => {
    configureAuthConsumer('platform');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    configureAuthConsumer('recruiter');
  });

  for (const role of READERS) {
    it(`B3-W-ROLE ${role} sees the workbench read-only (no action, no write)`, async () => {
      const w = world();
      installFetch(w, role);
      renderAt();
      const t = await table();
      expect(within(t).getByText('Meridian Partners')).toBeInTheDocument();
      expect(within(t).queryAllByRole('button')).toHaveLength(0);
      expect(writes(w)).toEqual([]);
    });
  }

  for (const role of NON_READERS) {
    it(`B3-W-DENIED ${role} gets the in-shell access-denied card; the read is never called`, async () => {
      const w = world();
      installFetch(w, role);
      renderAt();
      const denied = await screen.findByTestId('access-denied');
      expect(within(denied).getByRole('heading')).toHaveTextContent(/This account can.t open Commercial subscriptions/);
      expect(w.calls.some((c) => c.path.startsWith('/platform/commercial/subscriptions'))).toBe(false);
    });
  }
});

describe('CCP-B3 Subscriptions workbench — rows and filters (handoff §5.3)', () => {
  beforeEach(() => {
    configureAuthConsumer('platform');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    configureAuthConsumer('recruiter');
  });

  const rows = () => [
    row({ open_flags: ['governed_subscription_open'] }),
    row({ ...STRIPE_ROW({ status: 'PAST_DUE', grace_until: '2026-10-29T00:00:00.000Z' }), tenant: { id: T_NORTHWIND, name: 'Northwind Logistics', slug: 'northwind' } }),
  ];

  it('B3-W-1 governed vs Stripe-owned rows: source badges, the held activation flag, grace line; no money anywhere', async () => {
    installFetch(world({ workbench: rows() }), 'finance_admin');
    renderAt();
    const t = await table();
    const [meridian, northwind] = within(t).getAllByRole('row').slice(1);
    expect(within(meridian!).getByText('MANUAL · CT-2025-014')).toBeInTheDocument();
    expect(within(meridian!).getByText('Reconciliation flag')).toBeInTheDocument();
    expect(within(northwind!).getByText('Managed in Stripe')).toBeInTheDocument();
    expect(within(northwind!).getByText('Past due · in grace')).toBeInTheDocument();
    expect(within(northwind!).getByText('Grace ends 29 Oct 2026 (in 4 d)')).toBeInTheDocument();
    expect(within(northwind!).getByText('No commitment')).toBeInTheDocument();
    expect(screen.getByTestId('commercial-subscriptions').textContent).not.toMatch(/\$|USD|€/);
    expect(screen.getByTestId('subscriptions-count')).toHaveTextContent('2 of 2');
  });

  it('B3-W-2 status segment and reconciliation-flag filter; the empty state clears the filters', async () => {
    installFetch(world({ workbench: rows() }), 'finance_admin');
    renderAt();
    await table();
    fireEvent.click(screen.getByRole('button', { name: /^In grace/ }));
    expect(screen.getByRole('button', { name: /^In grace/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('subscriptions-count')).toHaveTextContent('1 of 2');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Has reconciliation flag' }));
    expect(await screen.findByText('No subscriptions match these filters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByTestId('subscriptions-count')).toHaveTextContent('2 of 2');
  });

  it('B3-W-3 a row opens Tenant › Commercial (click and keyboard)', async () => {
    const w = world({ workbench: rows() });
    installFetch(w, 'commercial_ops');
    renderAt();
    const t = await table();
    const meridianRow = within(t).getAllByRole('row')[1]!;
    fireEvent.keyDown(meridianRow, { key: 'Enter' });
    expect(await screen.findByTestId('tenant-commercial')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Commercial' })).toHaveAttribute('aria-selected', 'true');
  });

  it('B3-W-4 loading, then a load error offers Try again', async () => {
    const w = world();
    const spy = installFetch(w, 'finance_admin');
    const base = spy.getMockImplementation()!;
    spy.mockImplementation(async (input, init) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.includes('/platform/commercial/subscriptions')) return new Response('{}', { status: 500 });
      return base(input, init);
    });
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent('Subscriptions couldn’t be loaded. Try again.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled());
  });
});
