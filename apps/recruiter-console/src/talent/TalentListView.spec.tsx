import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TalentListView } from './TalentListView';
import type { TalentRecordView } from './types';

function makeTalent(
  id: string,
  first: string,
  last: string,
  overrides: Partial<TalentRecordView> = {},
): TalentRecordView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    first_name: first,
    last_name: last,
    email1: null,
    email2: null,
    phone_home: null,
    phone_cell: null,
    phone_work: null,
    address: null,
    address2: null,
    city: null,
    state: null,
    zip: null,
    source: null,
    key_skills: null,
    current_employer: null,
    current_pay: null,
    desired_pay: null,
    date_available: null,
    can_relocate: false,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    owner_id: null,
    entered_by_id: null,
    core_talent_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function mockFetch(items: readonly TalentRecordView[], status = 200) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ items }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetchError(status: number) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ message: 'forbidden' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('TalentListView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('frames the list as the tenant POOL — not a personal list', async () => {
    mockFetch([]);
    render(<TalentListView />);
    // Header carries the pool framing.
    await waitFor(() =>
      expect(screen.getByText('Talent')).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/tenant talent pool/i),
    ).toBeInTheDocument();
    // Empty-state is honest about the shared pool.
    expect(
      screen.getByText(/no talent yet in this tenant pool/i),
    ).toBeInTheDocument();
    // Crucially: NO personal-ownership framing.
    expect(screen.queryByText(/my talent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/your talent/i)).not.toBeInTheDocument();
  });

  it('renders the columns from the talent-record fields', async () => {
    mockFetch([
      makeTalent('tal-1', 'Ada', 'Lovelace', {
        email1: 'ada@example.com',
        phone_cell: '555-0100',
        current_employer: 'Analytical Engines Ltd',
        key_skills: 'Bernoulli numbers, mechanical computing',
        is_hot: true,
        can_relocate: true,
      }),
    ]);
    render(<TalentListView />);
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('555-0100')).toBeInTheDocument();
    expect(screen.getByText('Analytical Engines Ltd')).toBeInTheDocument();
    expect(
      screen.getByText(/Bernoulli numbers, mechanical computing/),
    ).toBeInTheDocument();
    // Hot + Relocate render as "Yes" when true.
    expect(screen.getAllByText('Yes').length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a permission message when the BE returns 403', async () => {
    mockFetchError(403);
    render(<TalentListView />);
    await waitFor(() =>
      expect(
        screen.getByText(/do not have permission to view talent/i),
      ).toBeInTheDocument(),
    );
  });

  it('discloses the truncation when the BE default cap is hit', async () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      makeTalent(`tal-${i}`, `First${i}`, `Last${i}`),
    );
    mockFetch(items);
    render(<TalentListView />);
    await waitFor(() =>
      expect(
        screen.getByTestId('talent-cap-banner'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/showing first 50 talent records/i),
    ).toBeInTheDocument();
  });

  it('does NOT show the cap banner when the list is under the cap', async () => {
    mockFetch([makeTalent('tal-1', 'Ada', 'Lovelace')]);
    render(<TalentListView />);
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('talent-cap-banner'),
    ).not.toBeInTheDocument();
  });
});
