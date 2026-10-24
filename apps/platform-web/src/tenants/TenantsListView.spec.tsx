import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformApi, type PlatformTenantSummary } from '../platform-api';

import { TenantsListView, filterTenants, sortTenants } from './TenantsListView';
import { ALL_TENANT_SCOPES, READ_ONLY_TENANT, renderAt, tenantSession } from './test-utils';

// PLATFORM-UX-1 F-4 (handoff §6.1) — URL filters (status, kind, q), segmented
// counts, client-side sort with aria-sort, the pager line, muted rows, the
// empty state with Clear filters, and the :provision-gated primary action.

const row = (o: Partial<PlatformTenantSummary> & Pick<PlatformTenantSummary, 'id' | 'name'>): PlatformTenantSummary => ({
  kind: 'BUSINESS',
  slug: o.name.toLowerCase().replace(/\s+/g, '-'),
  status: 'ACTIVE',
  status_reason_code: null,
  status_changed_at: '2026-03-01T00:00:00Z',
  is_active: true,
  created_at: '2026-03-01T00:00:00Z',
  activated_at: '2026-03-02T00:00:00Z',
  suspended_at: null,
  ...o,
});

const ROWS: PlatformTenantSummary[] = [
  row({ id: 'a', name: 'Northwind', created_at: '2026-03-02T00:00:00Z' }),
  row({ id: 'b', name: 'Halvorsen', status: 'PROVISIONED', activated_at: null, created_at: '2026-10-02T00:00:00Z' }),
  row({ id: 'c', name: 'Meridian', status: 'SUSPENDED', status_reason_code: 'payment_overdue', created_at: '2026-05-19T00:00:00Z' }),
  row({ id: 'd', name: 'Odile Marchand', kind: 'PERSONAL', created_at: '2026-10-19T00:00:00Z' }),
  row({ id: 'e', name: 'Calder', status: 'CLOSED', created_at: '2025-06-20T00:00:00Z' }),
];

const renderList = (url = '/tenants', scopes = ALL_TENANT_SCOPES) => {
  vi.spyOn(platformApi, 'listTenants').mockResolvedValue({ tenants: ROWS });
  return renderAt(<TenantsListView session={tenantSession(scopes)} />, { path: '/tenants', url, session: tenantSession(scopes) });
};

const names = (): string[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]?.textContent ?? '');

describe('filterTenants / sortTenants', () => {
  it('counts statuses over the kind + search base', () => {
    const { visible, counts } = filterTenants(ROWS, { status: 'ACTIVE', kind: 'BUSINESS', q: '' });
    expect(visible.map((t) => t.id)).toEqual(['a']);
    expect(counts).toMatchObject({ ALL: 4, ACTIVE: 1, PROVISIONED: 1, SUSPENDED: 1, CLOSED: 1, OFFBOARDING: 0 });
  });
  it('searches name or slug', () => {
    expect(filterTenants(ROWS, { status: 'ALL', kind: 'ALL', q: 'odile-' }).visible.map((t) => t.id)).toEqual(['d']);
    expect(filterTenants(ROWS, { status: 'ALL', kind: 'ALL', q: 'MERID' }).visible.map((t) => t.id)).toEqual(['c']);
  });
  it('sorts by any key in both directions', () => {
    expect(sortTenants(ROWS, { key: 'name', dir: 1 }).map((t) => t.id)).toEqual(['e', 'b', 'c', 'a', 'd']);
    expect(sortTenants(ROWS, { key: 'created', dir: -1 })[0]?.id).toBe('d');
  });
});

describe('TenantsListView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults to Created descending with aria-sort and the pager line', async () => {
    renderList();
    await screen.findByText('Northwind');
    expect(names()).toEqual(['Odile Marchand', 'Halvorsen', 'Meridian', 'Northwind', 'Calder']);
    expect(screen.getByRole('columnheader', { name: /Created/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /Tenant/ })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByText('Showing 1–5 of 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByText('5 tenants')).toBeInTheDocument();
  });

  it('sorts on header click and toggles direction', async () => {
    renderList();
    await screen.findByText('Northwind');
    fireEvent.click(screen.getByRole('button', { name: /^Tenant/ }));
    expect(screen.getByRole('columnheader', { name: /Tenant/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(names()[0]).toBe('Calder');
    fireEvent.click(screen.getByRole('button', { name: /^Tenant/ }));
    expect(screen.getByRole('columnheader', { name: /Tenant/ })).toHaveAttribute('aria-sort', 'descending');
    expect(names()[0]).toBe('Odile Marchand');
  });

  it('reads status, kind and q from the URL', async () => {
    renderList('/tenants?status=ACTIVE&kind=PERSONAL');
    await screen.findByText('Odile Marchand');
    expect(names()).toEqual(['Odile Marchand']);
    expect(screen.getByRole('button', { name: /^Active/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveValue('PERSONAL');
  });

  it('writes filters to the URL with segmented counts', async () => {
    renderList();
    await screen.findByText('Northwind');
    const suspended = screen.getByRole('button', { name: /^Suspended/ });
    expect(within(suspended).getByText('1')).toBeInTheDocument();
    fireEvent.click(suspended);
    expect(screen.getByTestId('location')).toHaveTextContent('/tenants?status=SUSPENDED');
    expect(names()).toEqual(['Meridian']);
    expect(screen.getByText('Payment overdue')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search name or slug' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No tenants match these filters')).toBeInTheDocument();
    expect(screen.getByText('Showing 0 of 0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/tenants$/);
    expect(names()).toHaveLength(5);
  });

  it('mutes Closed and Offboarding rows and opens a row on click', async () => {
    renderList();
    await screen.findByText('Calder');
    expect(screen.getByRole('row', { name: 'Open Calder' })).toHaveClass('pt-row--muted');
    expect(screen.getByRole('row', { name: 'Open Northwind' })).not.toHaveClass('pt-row--muted');
    fireEvent.click(screen.getByRole('row', { name: 'Open Northwind' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/tenants/a');
  });

  it('shows + Provision tenant only with :provision', async () => {
    renderList();
    await screen.findByText('Northwind');
    expect(screen.getByRole('button', { name: '+ Provision tenant' })).toBeInTheDocument();
  });

  it('hides + Provision tenant without :provision', async () => {
    renderList('/tenants', READ_ONLY_TENANT);
    await screen.findByText('Northwind');
    expect(screen.queryByRole('button', { name: '+ Provision tenant' })).not.toBeInTheDocument();
  });

  it('shows an error with Try again', async () => {
    vi.spyOn(platformApi, 'listTenants').mockRejectedValueOnce(new Error('x')).mockResolvedValue({ tenants: ROWS });
    renderAt(<TenantsListView session={tenantSession(ALL_TENANT_SCOPES)} />, {
      path: '/tenants',
      url: '/tenants',
      session: tenantSession(ALL_TENANT_SCOPES),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Northwind')).toBeInTheDocument();
  });
});
