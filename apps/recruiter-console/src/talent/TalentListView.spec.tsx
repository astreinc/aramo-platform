import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TalentListView } from './TalentListView';
import type { TalentRecordView } from './types';

function renderInRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

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
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ items }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function mockFetchError(status: number) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ message: 'forbidden' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

describe('TalentListView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('frames the list as the tenant POOL — honest about the shared pool', async () => {
    mockFetch([]);
    renderInRouter(<TalentListView />);
    await waitFor(() => expect(screen.getByText('Talent')).toBeInTheDocument());
    expect(screen.getByText(/tenant talent pool/i)).toBeInTheDocument();
    expect(
      screen.getByText(/no talent yet in this tenant pool/i),
    ).toBeInTheDocument();
    // Default filter is the full pool, not a personal default.
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('enforces the refusal layer in the footer (no open-web search / no bulk export)', async () => {
    mockFetch([]);
    renderInRouter(<TalentListView />);
    await waitFor(() => expect(screen.getByText('Talent')).toBeInTheDocument());
    expect(
      screen.getByText(/open-web talent search or bulk export/i),
    ).toBeInTheDocument();
  });

  it('renders the backed columns: name, skill chips, location, stated rate', async () => {
    mockFetch([
      makeTalent('tal-1', 'Ada', 'Lovelace', {
        city: 'London',
        state: 'UK',
        current_pay: '$120/hr',
        key_skills: 'Rust, Distributed Systems, AWS, Kafka',
        is_hot: true,
      }),
    ]);
    renderInRouter(<TalentListView />);
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    // Skills split into chips with a +N overflow (4 skills, max 3).
    expect(screen.getByText('Rust')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('London, UK')).toBeInTheDocument();
    expect(screen.getByText('$120/hr')).toBeInTheDocument();
  });

  it('the name cell links to /talent/:id (a11y nav path)', async () => {
    mockFetch([makeTalent('tal-42', 'Ada', 'Lovelace')]);
    renderInRouter(<TalentListView />);
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute(
      'href',
      '/talent/tal-42',
    );
  });

  it('"My talent" filters to records the actor owns (additive over the open pool)', async () => {
    mockFetch([
      makeTalent('t1', 'Mine', 'One', { owner_id: 'u1' }),
      makeTalent('t2', 'Other', 'Two', { owner_id: 'u2' }),
    ]);
    renderInRouter(
      <TalentListView
        sessionOverride={{
          sub: 'u1',
          consumer_type: 'recruiter',
          tenant_id: 't',
          scopes: ['talent:read'],
          iat: 0,
          exp: 0,
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText('Mine One')).toBeInTheDocument());
    expect(screen.getByText('Other Two')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'My talent' }));
    expect(screen.getByText('Mine One')).toBeInTheDocument();
    expect(screen.queryByText('Other Two')).not.toBeInTheDocument();
  });

  it('surfaces a permission message when the BE returns 403', async () => {
    mockFetchError(403);
    renderInRouter(<TalentListView />);
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
    renderInRouter(<TalentListView />);
    await waitFor(() =>
      expect(screen.getByTestId('talent-cap-banner')).toBeInTheDocument(),
    );
    expect(screen.getByText(/showing the first 50/i)).toBeInTheDocument();
  });

  it('does NOT show the cap banner when the list is under the cap', async () => {
    mockFetch([makeTalent('tal-1', 'Ada', 'Lovelace')]);
    renderInRouter(<TalentListView />);
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('talent-cap-banner')).not.toBeInTheDocument();
  });

  it('hides "New talent" without talent:create', async () => {
    mockFetch([makeTalent('tal-1', 'Ada', 'Lovelace')]);
    renderInRouter(
      <TalentListView
        sessionOverride={{
          sub: 'u1',
          consumer_type: 'recruiter',
          tenant_id: 't',
          scopes: ['talent:read'],
          iat: 0,
          exp: 0,
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: /new talent/i })).toBeNull();
  });

  it('shows "New talent" linking to /talent/new when scoped', async () => {
    mockFetch([makeTalent('tal-1', 'Ada', 'Lovelace')]);
    renderInRouter(
      <TalentListView
        sessionOverride={{
          sub: 'u1',
          consumer_type: 'recruiter',
          tenant_id: 't',
          scopes: ['talent:read', 'talent:create'],
          iat: 0,
          exp: 0,
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /new talent/i })).toHaveAttribute(
      'href',
      '/talent/new',
    );
  });
});
