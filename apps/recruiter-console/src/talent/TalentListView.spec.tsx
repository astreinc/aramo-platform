import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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
    availability_status: null,
    engagement_type: null,
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

// URL-routed fetch mock. talent-records → `talent`; tenant/users → roster (or
// status); everything else (pipelines/activities/requisitions) → empty/200.
function mockRoutes(opts: {
  talent?: readonly TalentRecordView[];
  talentStatus?: number;
  roster?: unknown;
  rosterStatus?: number;
} = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), {
        status: s,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.includes('/v1/tenant/users'))
      return json(opts.roster ?? { items: [] }, opts.rosterStatus ?? 200);
    if (url.includes('/v1/talent-records'))
      return json({ items: opts.talent ?? [] }, opts.talentStatus ?? 200);
    return json({ items: [] });
  });
}

const SESSION = {
  sub: 'u1',
  consumer_type: 'recruiter' as const,
  tenant_id: 't',
  scopes: ['talent:read'],
  iat: 0,
  exp: 0,
};

describe('TalentListView (faceted workspace)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the consented-pool framing + the R7/G3 refusal footer (Talent vocab)', async () => {
    mockRoutes({ talent: [] });
    renderInRouter(<TalentListView />);
    await waitFor(() => expect(screen.getByText('Talent')).toBeInTheDocument());
    expect(screen.getByText(/your consented working set/i)).toBeInTheDocument();
    expect(
      screen.getByText(/open-web talent search or bulk export/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no talent yet in this tenant pool/i),
    ).toBeInTheDocument();
  });

  it('renders the backed columns: name link, skill chips +overflow, location, rate', async () => {
    mockRoutes({
      talent: [
        makeTalent('tal-1', 'Ada', 'Lovelace', {
          city: 'London',
          state: 'UK',
          current_pay: '$120/hr',
          key_skills: 'Rust, Distributed Systems, AWS, Kafka',
          is_hot: true,
        }),
      ],
    });
    renderInRouter(<TalentListView />);
    await waitFor(() =>
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(),
    );
    expect(screen.getAllByText('Rust').length).toBeGreaterThan(0); // chip + facet
    expect(screen.getByText('+1')).toBeInTheDocument(); // 4 skills, show 3
    expect(screen.getByText('London, UK')).toBeInTheDocument();
    expect(screen.getByText('$120/hr')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ada Lovelace/ })).toHaveAttribute(
      'href',
      '/talent/tal-1',
    );
  });

  it('resolves the Owner column via the roster probe', async () => {
    mockRoutes({
      talent: [makeTalent('tal-1', 'Ada', 'Lovelace', { owner_id: 'u-own' })],
      roster: {
        items: [
          { user_id: 'u-own', email: 'o@x.test', display_name: 'Tom Owner', is_active: true },
        ],
      },
    });
    renderInRouter(<TalentListView />);
    await waitFor(() =>
      expect(screen.getByText('Tom Owner')).toBeInTheDocument(),
    );
  });

  it('the "N of M" count + a skill facet narrows the loaded set', async () => {
    mockRoutes({
      talent: [
        makeTalent('1', 'Ada', 'Lovelace', { key_skills: 'Rust' }),
        makeTalent('2', 'Bob', 'Khan', { key_skills: 'Go' }),
      ],
    });
    renderInRouter(<TalentListView />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(screen.getByText(/of 2 talent/i)).toBeInTheDocument();
    // tick the Rust skill facet (label carries a count)
    fireEvent.click(screen.getByRole('checkbox', { name: /^Rust/ }));
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByText('Bob Khan')).not.toBeInTheDocument();
  });

  it('token search: skill: token filters; status: token is flagged, non-filtering', async () => {
    mockRoutes({
      talent: [
        makeTalent('1', 'Ada', 'Lovelace', { key_skills: 'Rust' }),
        makeTalent('2', 'Bob', 'Khan', { key_skills: 'Go' }),
      ],
    });
    renderInRouter(<TalentListView />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    const box = screen.getByRole('textbox', { name: /search talent/i });
    fireEvent.change(box, { target: { value: 'skill:Rust' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByText('Bob Khan')).not.toBeInTheDocument();
    // a status: token stays as a flagged chip and does not filter
    fireEvent.change(box, { target: { value: 'status:active' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByText(/·ignored/)).toBeInTheDocument();
  });

  it('"My talent" scope tab filters to actor-owned rows', async () => {
    mockRoutes({
      talent: [
        makeTalent('1', 'Mine', 'One', { owner_id: 'u1' }),
        makeTalent('2', 'Other', 'Two', { owner_id: 'u2' }),
      ],
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Mine One')).toBeInTheDocument());
    const scope = screen.getByRole('group', { name: 'Scope' });
    fireEvent.click(within(scope).getByRole('button', { name: 'My talent' }));
    expect(screen.getByText('Mine One')).toBeInTheDocument();
    expect(screen.queryByText('Other Two')).not.toBeInTheDocument();
  });

  it('selecting a row reveals the bulk bar with the Export moat disabled', async () => {
    mockRoutes({ talent: [makeTalent('1', 'Ada', 'Lovelace')] });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /select ada lovelace/i }));
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toBeInTheDocument();
    expect(screen.getByText(/export off — consent-protected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add to req/i })).toBeInTheDocument();
  });

  it('clicking a row opens the triage drawer (non-modal) with key facts', async () => {
    mockRoutes({ talent: [makeTalent('1', 'Ada', 'Lovelace', { source: 'Referral' })] });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /preview ada lovelace/i }));
    const drawer = await screen.findByRole('dialog', { name: /ada lovelace — triage/i });
    expect(within(drawer).getByText('Key facts')).toBeInTheDocument();
    expect(within(drawer).getByText('Match insight')).toBeInTheDocument();
  });

  it('renders the Availability pill + the Availability facet narrows the set', async () => {
    mockRoutes({
      talent: [
        makeTalent('1', 'Ada', 'Lovelace', { availability_status: 'available_now' }),
        makeTalent('2', 'Bob', 'Khan', { availability_status: 'not_looking' }),
      ],
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    // stated-status pill in the Availability column (also a facet label → ≥1)
    expect(screen.getAllByText('Available now').length).toBeGreaterThan(0);
    // facet checkbox (label carries a count) narrows to the matching row
    fireEvent.click(screen.getByRole('checkbox', { name: /^Available now/ }));
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByText('Bob Khan')).not.toBeInTheDocument();
  });

  it('column-customize toggles a column off (Rate hidden via the Columns menu)', async () => {
    mockRoutes({
      talent: [makeTalent('1', 'Ada', 'Lovelace', { current_pay: '$120/hr' })],
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(screen.getByText('$120/hr')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Columns')); // open the <details> menu
    fireEvent.click(screen.getByRole('checkbox', { name: 'Rate' }));
    expect(screen.queryByText('$120/hr')).not.toBeInTheDocument();
  });

  it('discloses the truncation when the BE default cap is hit', async () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      makeTalent(`tal-${i}`, `First${i}`, `Last${i}`),
    );
    mockRoutes({ talent: items });
    renderInRouter(<TalentListView />);
    await waitFor(() =>
      expect(screen.getByTestId('talent-cap-banner')).toBeInTheDocument(),
    );
  });

  it('surfaces a permission message when the BE returns 403', async () => {
    mockRoutes({ talent: [], talentStatus: 403 });
    renderInRouter(<TalentListView />);
    await waitFor(() =>
      expect(
        screen.getByText(/do not have permission to view talent/i),
      ).toBeInTheDocument(),
    );
  });

  it('hides "Add talent" without talent:create and shows it (→ /talent/new) when scoped', async () => {
    mockRoutes({ talent: [makeTalent('1', 'Ada', 'Lovelace')] });
    const { unmount } = renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /add talent/i })).toBeNull();
    unmount();

    mockRoutes({ talent: [makeTalent('1', 'Ada', 'Lovelace')] });
    renderInRouter(
      <TalentListView
        sessionOverride={{ ...SESSION, scopes: ['talent:read', 'talent:create'] }}
      />,
    );
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /add talent/i })).toHaveAttribute(
      'href',
      '/talent/new',
    );
  });
});
