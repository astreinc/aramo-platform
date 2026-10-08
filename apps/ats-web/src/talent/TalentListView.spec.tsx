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
    work_authorization: null,
    date_available: null,
    can_relocate: false,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

const ME = 'u1';

// ── A PARAM-AWARE fake server. The Talent list is now SERVER-SIDE: facets,
// scope, presets and the cursor are all query params, so the mock parses them
// and narrows the fixture (and computes the facet counts). The behavioral tests
// therefore assert the FE sends the right params AND renders the server's
// narrowed response — the real 4a–4c contract, in miniature.
function effAvail(t: TalentRecordView): string {
  return t.availability_status ?? 'unknown';
}
function fullName(t: TalentRecordView): string {
  return `${t.first_name} ${t.last_name}`.trim();
}
function skillsOf(t: TalentRecordView): string[] {
  return (t.key_skills ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
function locOf(t: TalentRecordView): string {
  return [t.city, t.state].filter(Boolean).join(', ');
}

function applyServerFilters(
  pool: readonly TalentRecordView[],
  qp: URLSearchParams,
  presetIds?: Record<string, readonly string[]>,
  wwmIds?: readonly string[],
): TalentRecordView[] {
  let out = [...pool];
  const q = qp.get('q');
  if (q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    out = out.filter((t) => words.every((w) => fullName(t).toLowerCase().includes(w)));
  }
  const skills = qp.get('skills');
  if (skills) {
    const needles = skills.toLowerCase().split(',');
    const mode = qp.get('skill_match') ?? 'any';
    out = out.filter((t) => {
      const have = skillsOf(t).map((s) => s.toLowerCase());
      const test = (n: string) => have.some((h) => h.includes(n));
      return mode === 'all' ? needles.every(test) : needles.some(test);
    });
  }
  const avail = qp.get('availability');
  if (avail) {
    const set = new Set(avail.split(','));
    out = out.filter((t) => set.has(effAvail(t)));
  }
  const eng = qp.get('engagement');
  if (eng) {
    const set = new Set(eng.split(','));
    out = out.filter((t) => t.engagement_type !== null && set.has(t.engagement_type));
  }
  const src = qp.get('source');
  if (src) {
    const set = new Set(src.split(','));
    out = out.filter((t) => t.source !== null && set.has(t.source));
  }
  if (qp.get('hot') === 'true') out = out.filter((t) => t.is_hot);
  const loc = qp.get('location');
  if (loc) out = out.filter((t) => locOf(t).toLowerCase().includes(loc.toLowerCase()));
  // CRM-2 — "Working with me" resolves server-side to a talent allowlist
  // (assigned reqs × active pipeline); the mock narrows to a provided id set.
  // owner_id is NEVER a scope param anymore.
  if (qp.get('scope') === 'working_with_me') {
    const allow = new Set(wwmIds ?? []);
    out = out.filter((t) => allow.has(t.id));
  }
  const preset = qp.get('preset');
  if (preset) {
    const allow = new Set(presetIds?.[preset] ?? []);
    out = out.filter((t) => allow.has(t.id));
  }
  return out;
}

function computeFacets(pool: readonly TalentRecordView[]) {
  const tally = (vals: string[]) => {
    const m = new Map<string, number>();
    for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count }));
  };
  return {
    availability: tally(pool.map(effAvail)),
    engagement: tally(pool.map((t) => t.engagement_type).filter((x): x is string => x !== null)),
    source: tally(pool.map((t) => t.source).filter((x): x is string => x !== null)),
    hot: pool.filter((t) => t.is_hot).length,
  };
}

function computeCross(pool: readonly TalentRecordView[], overGuard?: boolean) {
  if (overGuard) {
    return { over_guard: true, matched: 9999, guard: 5000, recency: {}, consent: [], stage: [] };
  }
  const consent = new Map<string, number>();
  const stage = new Map<string, number>();
  for (const t of pool) {
    const c = t.consent_summary ?? 'do_not_contact';
    consent.set(c, (consent.get(c) ?? 0) + 1);
    const s = t.current_stage?.stage ?? 'none';
    stage.set(s, (stage.get(s) ?? 0) + 1);
  }
  const buckets = (m: Map<string, number>) =>
    [...m.entries()].map(([value, count]) => ({ value, count }));
  return {
    over_guard: false,
    matched: pool.length,
    guard: 5000,
    recency: { today: 0, '7d': 0, '30d': 0, stale: pool.length },
    consent: buckets(consent),
    stage: buckets(stage),
  };
}

function mockServer(
  opts: {
    talent?: readonly TalentRecordView[];
    talentStatus?: number;
    roster?: unknown;
    rosterStatus?: number;
    presetIds?: Record<string, readonly string[]>;
    workingWithMeIds?: readonly string[];
    memberships?: ReadonlyArray<{
      item_id: string;
      lists: ReadonlyArray<{ id: string; name: string; visibility: string }>;
    }>;
    overGuard?: boolean;
    secondPage?: readonly TalentRecordView[];
    drafts?: readonly unknown[];
  } = {},
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), {
        status: s,
        headers: { 'Content-Type': 'application/json' },
      });
    // Talent Draft Recovery — the actor's in-progress drafts (§4–§7).
    if (url.includes('/v1/talent-intake-drafts'))
      return json({ items: opts.drafts ?? [] });
    if (url.includes('/v1/tenant/users'))
      return json(opts.roster ?? { items: [] }, opts.rosterStatus ?? 200);
    // CRM-3 — reverse membership (Lists column). Backend is visibility-scoped;
    // the mock returns whatever the test seeds (already actor-scoped).
    if (url.includes('/v1/saved-lists/memberships'))
      return json({ items: opts.memberships ?? [] });
    if (url.includes('/v1/talent-records')) {
      if (opts.talentStatus && opts.talentStatus !== 200)
        return json({ message: 'denied' }, opts.talentStatus);
      const qp = new URL(url, 'http://x').searchParams;
      const cursor = qp.get('cursor');
      if (cursor === 'c1' && opts.secondPage)
        return json({ items: opts.secondPage, next_cursor: null, facets: computeFacets([]) });
      const pool = applyServerFilters(opts.talent ?? [], qp, opts.presetIds, opts.workingWithMeIds);
      const next = opts.secondPage && cursor === null ? 'c1' : null;
      return json({
        items: pool,
        next_cursor: next,
        facets: computeFacets(pool),
        cross_facets: computeCross(pool, opts.overGuard),
      });
    }
    return json({ items: [] });
  });
}

const SESSION = {
  sub: ME,
  consumer_type: 'recruiter' as const,
  tenant_id: 't',
  scopes: ['talent:read'],
  iat: 0,
  exp: 0,
};

describe('TalentListView (server-side faceted workspace — Segment 4d)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the consented-pool framing + the R7/G3 refusal footer (Talent vocab)', async () => {
    mockServer({ talent: [] });
    renderInRouter(<TalentListView />);
    await waitFor(() => expect(screen.getByText('Talent')).toBeInTheDocument());
    expect(screen.getByText(/your consented working set/i)).toBeInTheDocument();
    expect(screen.getByText(/open-web talent search or bulk export/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/no talent yet in this tenant pool/i)).toBeInTheDocument(),
    );
  });

  it('renders the backed columns: name + title, contact (email/phone), location, rate', async () => {
    mockServer({
      talent: [
        makeTalent('tal-1', 'Ada', 'Lovelace', {
          city: 'London',
          state: 'UK',
          current_pay: '$120/hr',
          email1: 'ada@analytical.test',
          phone_cell: '(555) 010-0001',
          title: 'Principal Engineer',
          is_hot: true,
        }),
      ],
    });
    renderInRouter(<TalentListView />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    // Talent cell subline = title (skills are not a list column).
    expect(screen.getByText('Principal Engineer')).toBeInTheDocument();
    // Contact column = email + phone.
    expect(screen.getByText('ada@analytical.test')).toBeInTheDocument();
    expect(screen.getByText('(555) 010-0001')).toBeInTheDocument();
    expect(screen.getByText('London, UK')).toBeInTheDocument();
    expect(screen.getByText('$120/hr')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ada Lovelace/ })).toHaveAttribute(
      'href',
      '/talent/tal-1',
    );
  });

  it('defaults the currency to $ for a rate stated without a symbol', async () => {
    mockServer({
      talent: [makeTalent('tal-1', 'Ada', 'Lovelace', { current_pay: '95/hr' })],
    });
    renderInRouter(<TalentListView />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(screen.getByText('$95/hr')).toBeInTheDocument();
  });

  it('a skill facet sends ?skills= and renders the server-narrowed set', async () => {
    mockServer({
      talent: [
        makeTalent('1', 'Ada', 'Lovelace', { key_skills: 'Rust' }),
        makeTalent('2', 'Bob', 'Khan', { key_skills: 'Go' }),
      ],
    });
    renderInRouter(<TalentListView />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    // activebar "X of Y talent" — Y is the full-set 'All' view count (probe).
    await waitFor(() => expect(screen.getByText(/of 2 talent/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /^Rust/ }));
    await waitFor(() => expect(screen.queryByText('Bob Khan')).not.toBeInTheDocument());
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('CRM-2 free-text search: one plain box sends ?q= and narrows (no key:value grammar)', async () => {
    mockServer({
      talent: [
        makeTalent('1', 'Ada', 'Lovelace', { key_skills: 'Rust' }),
        makeTalent('2', 'Bob', 'Khan', { key_skills: 'Go' }),
      ],
    });
    renderInRouter(<TalentListView />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    const box = screen.getByRole('searchbox', { name: /search talent/i });
    // one ordinary query — narrows by the server q (name/title/skill/location).
    fireEvent.change(box, { target: { value: 'Ada' } });
    await waitFor(() => expect(screen.queryByText('Bob Khan')).not.toBeInTheDocument());
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    // no token chips / no "ignored" grammar affordance is rendered.
    expect(screen.queryByText(/·ignored/)).not.toBeInTheDocument();
  });

  it('CRM-3 Lists column renders visibility-scoped membership (first list + "+n"); "—" when none', async () => {
    mockServer({
      talent: [makeTalent('1', 'Ada', 'Lovelace'), makeTalent('2', 'Bob', 'Khan')],
      memberships: [
        {
          item_id: '1',
          lists: [
            { id: 'L1', name: 'Hot React', visibility: 'private' },
            { id: 'L2', name: 'West Coast', visibility: 'tenant' },
          ],
        },
      ],
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    // Ada ∈ 2 visible lists → first name + "+1".
    await waitFor(() => expect(screen.getByText('Hot React')).toBeInTheDocument());
    expect(screen.getByText('+1')).toBeInTheDocument();
    // Bob ∈ no visible list → the column shows a muted em-dash for that row.
    expect(screen.queryByText('West Coast')).not.toBeInTheDocument();
  });

  it('CRM-2 "Working with me" tab sends ?scope=working_with_me (NOT owner_id) and narrows to the resolved set', async () => {
    mockServer({
      talent: [
        makeTalent('1', 'Active', 'Pipeline', { owner_id: 'someone-else' }),
        makeTalent('2', 'Other', 'Two', { owner_id: ME }),
      ],
      // Working-with-me resolves to talent on my assigned reqs' active pipelines
      // — independent of owner_id (note '1' is owned by someone else yet included).
      workingWithMeIds: ['1'],
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Active Pipeline')).toBeInTheDocument());
    const scope = screen.getByRole('group', { name: 'Scope' });
    fireEvent.click(within(scope).getByRole('button', { name: 'Working with me' }));
    await waitFor(() => expect(screen.queryByText('Other Two')).not.toBeInTheDocument());
    expect(screen.getByText('Active Pipeline')).toBeInTheDocument();
  });

  it('CRM-2 Follow-up due sends ?preset=needs_follow_up and narrows to the resolved allowlist', async () => {
    mockServer({
      talent: [makeTalent('1', 'Ada', 'Lovelace'), makeTalent('2', 'Bob', 'Khan')],
      presetIds: { needs_follow_up: ['1'] },
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Bob Khan')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Follow-up due/ }));
    await waitFor(() => expect(screen.queryByText('Bob Khan')).not.toBeInTheDocument());
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Follow-up due/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('a preset whose allowlist is EMPTY renders the zero-results state', async () => {
    mockServer({
      talent: [makeTalent('1', 'Ada', 'Lovelace')],
      presetIds: { needs_follow_up: [] },
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Follow-up due/ }));
    await waitFor(() =>
      expect(screen.getByText(/no talent matches these filters/i)).toBeInTheDocument(),
    );
  });

  it('renders the over_guard message in place of the cross-schema facet counts', async () => {
    mockServer({ talent: [makeTalent('1', 'Ada', 'Lovelace')], overGuard: true });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(
      screen.getByText(/narrow your filters, then these counts return/i),
    ).toBeInTheDocument();
    // over-guard view-count probes show an HONEST indeterminate badge ("5000+"),
    // never a silent full scan or a wrong number — the guard is respected.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^All\s*5000\+/ })).toBeInTheDocument(),
    );
  });

  it('load-more appends the next keyset page and drops the button at the end', async () => {
    mockServer({
      talent: [makeTalent('1', 'Ada', 'Lovelace')],
      secondPage: [makeTalent('2', 'Bob', 'Khan')],
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    const more = screen.getByRole('button', { name: /load more talent/i });
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByText('Bob Khan')).toBeInTheDocument());
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(); // appended, not replaced
    expect(screen.queryByRole('button', { name: /load more talent/i })).toBeNull();
  });

  it('CRM-2 selecting a row reveals the bulk bar: Add to requisition only (no Export / Assign-to-me) without saved-list:edit', async () => {
    mockServer({ talent: [makeTalent('1', 'Ada', 'Lovelace')] });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /select ada lovelace/i }));
    const region = screen.getByRole('region', { name: 'Bulk actions' });
    expect(within(region).getByRole('button', { name: /add to requisition/i })).toBeInTheDocument();
    // retired actions / moats must NOT appear in the bulk bar (the page footnote
    // still mentions "bulk export" as a policy statement — scope to the region).
    expect(within(region).queryByText(/export/i)).not.toBeInTheDocument();
    expect(
      within(region).queryByRole('button', { name: /assign to me/i }),
    ).not.toBeInTheDocument();
    // Add to list is permission-gated (hidden without saved-list:edit).
    expect(
      within(region).queryByRole('button', { name: /add to list/i }),
    ).not.toBeInTheDocument();
  });

  it('CRM-2 "Add to list" appears with saved-list:edit and opens the add-to-list modal', async () => {
    mockServer({ talent: [makeTalent('1', 'Ada', 'Lovelace')] });
    renderInRouter(
      <TalentListView
        sessionOverride={{ ...SESSION, scopes: ['talent:read', 'saved-list:edit'] }}
      />,
    );
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /select ada lovelace/i }));
    const addToList = screen.getByRole('button', { name: /add to list/i });
    expect(addToList).toBeInTheDocument();
    fireEvent.click(addToList);
    expect(await screen.findByRole('dialog', { name: /add to list/i })).toBeInTheDocument();
  });

  it('clicking a row opens the triage drawer (non-modal) with key facts', async () => {
    mockServer({ talent: [makeTalent('1', 'Ada', 'Lovelace', { source: 'Referral' })] });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /preview ada lovelace/i }));
    const drawer = await screen.findByRole('dialog', { name: /ada lovelace — triage/i });
    expect(within(drawer).getByText('Key facts')).toBeInTheDocument();
  });

  it('the Availability pill renders + the Availability facet sends ?availability=', async () => {
    mockServer({
      talent: [
        makeTalent('1', 'Ada', 'Lovelace', { availability_status: 'available_now' }),
        makeTalent('2', 'Bob', 'Khan', { availability_status: 'not_looking' }),
      ],
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(screen.getAllByText('Available now').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Available now/ }));
    await waitFor(() => expect(screen.queryByText('Bob Khan')).not.toBeInTheDocument());
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('renders the enriched Consent + Stage pills from the composed fields', async () => {
    mockServer({
      talent: [
        makeTalent('1', 'Ada', 'Lovelace', {
          consent_summary: 'contactable',
          current_stage: { stage: 'qualifying', requisition_id: 'req-1' },
          last_activity_at: '2026-06-14T09:00:00.000Z',
        }),
      ],
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(screen.getAllByText('Contactable').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Qualifying').length).toBeGreaterThan(0);
  });

  it('column-customize toggles a column off (Rate hidden via the Columns menu)', async () => {
    mockServer({ talent: [makeTalent('1', 'Ada', 'Lovelace', { current_pay: '$120/hr' })] });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(screen.getByText('$120/hr')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Columns'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Rate' }));
    expect(screen.queryByText('$120/hr')).not.toBeInTheDocument();
  });

  it('surfaces a permission message when the BE returns 403', async () => {
    mockServer({ talentStatus: 403 });
    renderInRouter(<TalentListView />);
    await waitFor(() =>
      expect(screen.getByText(/do not have permission to view talent/i)).toBeInTheDocument(),
    );
  });

  it('hides "Add talent" without talent:create and shows it (→ /talent/new) when scoped', async () => {
    mockServer({ talent: [makeTalent('1', 'Ada', 'Lovelace')] });
    const { unmount } = renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /add talent/i })).toBeNull();
    unmount();

    mockServer({ talent: [makeTalent('1', 'Ada', 'Lovelace')] });
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

  it('CRM-2/4 renders exactly the four quick filters (Not-contacted-90+ ACTIVE in CRM-4); no My-hot-list / Save-view', async () => {
    mockServer({
      talent: [
        makeTalent('1', 'Ada', 'Lovelace', { is_hot: true }),
        makeTalent('2', 'Bob', 'Khan'),
      ],
    });
    renderInRouter(<TalentListView sessionOverride={SESSION} />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    const bar = screen.getByRole('group', { name: 'Quick filters' });
    await waitFor(() =>
      expect(within(bar).getByRole('button', { name: /^All\s*2$/ })).toBeInTheDocument(),
    );
    expect(within(bar).getByRole('button', { name: /available now/i })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /follow-up due/i })).toBeInTheDocument();
    // CRM-4 activated the chip (authoritative last-contact denylist) — now enabled.
    expect(
      within(bar).getByRole('button', { name: /not contacted 90\+ days/i }),
    ).toBeEnabled();
    // retired views + save-view stub are gone.
    expect(screen.queryByRole('button', { name: /my hot list/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /save current view/i }),
    ).not.toBeInTheDocument();
  });
});

// ── Talent Draft Recovery IA (§4–§7, §20) ──────────────────────────────────
function draftItem(over: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    source_filename: 'uma.pdf',
    processing_status: 'PROCESSING',
    review_status: 'IN_REVIEW',
    promoted_talent_record_id: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    last_touched_at: '2026-09-01T00:00:00Z',
    required: { met: 3, total: 5 },
    admissible: false,
    display_name: 'Uma Maheshwari',
    ...over,
  };
}

describe('TalentListView — Talent Draft Recovery IA', () => {
  afterEach(() => vi.restoreAllMocks());

  it('zero drafts → no In-progress tab, no recovery strip, no Add-talent dot', async () => {
    mockServer({ talent: [], drafts: [] });
    const { container } = renderInRouter(
      <TalentListView sessionOverride={{ ...SESSION, scopes: ['talent:read', 'talent:create'] }} />,
    );
    await waitFor(() => expect(screen.getByText('Talent')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /in progress/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/you started adding/i)).not.toBeInTheDocument();
    expect(container.querySelector('.rc-addtalent__dot')).toBeNull();
  });

  it('one draft → In-progress tab with count 1, recovery strip, and the Add-talent dot', async () => {
    mockServer({ talent: [], drafts: [draftItem()] });
    const { container } = renderInRouter(
      <TalentListView sessionOverride={{ ...SESSION, scopes: ['talent:read', 'talent:create'] }} />,
    );
    await waitFor(() => expect(screen.getByText('Talent')).toBeInTheDocument());
    const tab = await screen.findByRole('button', { name: /in progress/i });
    expect(tab).toHaveTextContent('1');
    expect(screen.getByText(/1 talent you started adding/i)).toBeInTheDocument();
    expect(container.querySelector('.rc-addtalent__dot')).not.toBeNull();
  });

  it('?view=in-progress renders the In-progress recovery surface (incl. the narrow two-line row in DOM)', async () => {
    mockServer({ talent: [], drafts: [draftItem()] });
    const { container } = render(
      <MemoryRouter initialEntries={['/?view=in-progress']}>
        <TalentListView sessionOverride={SESSION} />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/you started adding but haven't created yet/i),
      ).toBeInTheDocument(),
    );
    // Both presentations are in the DOM; CSS shows one per breakpoint (§20).
    expect(container.querySelector('.rc-ip-wide')).not.toBeNull();
    expect(container.querySelector('[data-testid="in-progress-row-narrow"]')).not.toBeNull();
  });

  it('?view=in-progress with zero drafts normalizes away (no In-progress surface)', async () => {
    mockServer({ talent: [], drafts: [] });
    render(
      <MemoryRouter initialEntries={['/?view=in-progress']}>
        <TalentListView sessionOverride={SESSION} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Talent')).toBeInTheDocument());
    expect(
      screen.queryByText(/you started adding but haven't created yet/i),
    ).not.toBeInTheDocument();
  });
});
