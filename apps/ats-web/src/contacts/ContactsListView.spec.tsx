import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import type { ContactView } from '../companies/types';

import { ContactsListView } from './ContactsListView';

function renderInRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}

function makeContact(
  id: string,
  first: string,
  last: string,
  overrides: Partial<ContactView> = {},
): ContactView {
  return {
    id, tenant_id: 't', site_id: null,
    first_name: first, last_name: last, title: null,
    email1: null, email2: null,
    phone_work: null, phone_cell: null, phone_other: null,
    address: null, company_id: 'co-1', company_department_id: null,
    is_hot: false, notes: null, left_company: false,
    reports_to_id: null, owner_id: null, entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    relationship_role: null, preference: null,
    last_activity_at: null, company_name: 'Acme Corp',
    ...overrides,
  };
}

function buildFacets(base: readonly ContactView[]) {
  const tally = (key: keyof ContactView) => {
    const m = new Map<string, number>();
    for (const c of base) {
      const v = c[key];
      if (v === null || v === undefined || v === '') continue;
      m.set(String(v), (m.get(String(v)) ?? 0) + 1);
    }
    return [...m.entries()].map(([value, count]) => ({ value, count }));
  };
  return {
    relationship_role: tally('relationship_role'),
    preference: tally('preference'),
    company: tally('company_id'),
    hot: base.filter((c) => c.is_hot).length,
    quiet: base.filter((c) => c.last_activity_at === null).length,
    former: base.filter((c) => c.left_company).length,
  };
}

// Server-aware fetch mock: replicates the BE base/selection split. Captures the
// last /v1/contacts URL so tests can assert the SERVER query params (scope,
// cold_callable) — the corrected-pattern proof for "My contacts".
let lastContactsUrl = '';
function installFetch(all: readonly ContactView[], status = 200) {
  lastContactsUrl = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/v1/tenant/users')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (status !== 200) {
      return new Response(JSON.stringify({ message: 'forbidden' }), {
        status, headers: { 'Content-Type': 'application/json' },
      });
    }
    lastContactsUrl = url;
    const u = new URL(url, 'http://x');
    const scope = u.searchParams.get('scope');
    // former excluded by default unless former=true
    const includeFormer = u.searchParams.get('former') === 'true';
    const coldCallable = u.searchParams.get('cold_callable') === 'true';
    const base = all.filter(
      (c) =>
        (scope === 'mine' ? c.owner_id === 'u1' : true) &&
        (includeFormer || !c.left_company) &&
        (!coldCallable ||
          (c.preference !== 'do_not_contact' &&
            c.phone_work !== null &&
            c.phone_work !== '')),
    );
    const roleSel = u.searchParams.get('relationship_role')?.split(',') ?? [];
    const prefSel = u.searchParams.get('preference')?.split(',') ?? [];
    const isHot = u.searchParams.get('is_hot') === 'true';
    const quiet = u.searchParams.get('quiet') === 'true';
    const items = base.filter(
      (c) =>
        (roleSel.length === 0 ||
          (c.relationship_role !== null && roleSel.includes(c.relationship_role))) &&
        (prefSel.length === 0 ||
          (c.preference !== null && prefSel.includes(c.preference))) &&
        (!isHot || c.is_hot) &&
        (!quiet || c.last_activity_at === null),
    );
    return new Response(
      JSON.stringify({ items, next_cursor: null, facets: buildFacets(base), total: base.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

describe('ContactsListView (server-paged)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('frames the list + empty state', async () => {
    installFetch([]);
    renderInRouter(<ContactsListView />);
    await waitFor(() =>
      expect(screen.getByText(/no contacts visible to you yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Contacts' })).toBeInTheDocument();
    expect(screen.getByText(/your client contacts/i)).toBeInTheDocument();
  });

  it('renders role + company from real fields', async () => {
    installFetch([
      makeContact('ct-1', 'Dana', 'Okafor', {
        title: 'VP Engineering', relationship_role: 'decision_maker',
        company_name: 'Northwind Robotics',
      }),
    ]);
    renderInRouter(<ContactsListView />);
    await waitFor(() => expect(screen.getByText('Dana Okafor')).toBeInTheDocument());
    const table = screen.getByRole('table');
    expect(within(table).getByText('Decision maker')).toBeInTheDocument();
    expect(within(table).getByText('Northwind Robotics')).toBeInTheDocument();
  });

  it('surfaces a permission message on 403', async () => {
    installFetch([], 403);
    renderInRouter(<ContactsListView />);
    await waitFor(() =>
      expect(
        screen.getByText(/do not have permission to view contacts/i),
      ).toBeInTheDocument(),
    );
  });

  it('the name cell links to the contact detail at /contacts/:id', async () => {
    installFetch([makeContact('ct-42', 'Dana', 'Okafor')]);
    renderInRouter(<ContactsListView />);
    await waitFor(() => expect(screen.getByText('Dana Okafor')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Dana Okafor/i })).toHaveAttribute(
      'href', '/contacts/ct-42',
    );
  });

  it('VISIBILITY: "My contacts" scope sends scope=mine server-side and shows only owned', async () => {
    installFetch([
      makeContact('ct-1', 'Mine', 'Owner', { owner_id: 'u1' }),
      makeContact('ct-2', 'Other', 'Owner', { owner_id: 'u2' }),
    ]);
    renderInRouter(<ContactsListView sessionOverride={makeSession(['contact:read'])} />);
    await waitFor(() => expect(screen.getByText('Mine Owner')).toBeInTheDocument());
    // both visible under All
    expect(screen.getByText('Other Owner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'My contacts' }));
    await waitFor(() => expect(screen.queryByText('Other Owner')).toBeNull());
    expect(screen.getByText('Mine Owner')).toBeInTheDocument();
    // the corrected pattern — owner narrowing is a SERVER param, not client-side.
    expect(lastContactsUrl).toContain('scope=mine');
  });

  it('the Decision makers segment refetches and filters server-side', async () => {
    installFetch([
      makeContact('ct-1', 'Dee', 'Maker', { relationship_role: 'decision_maker' }),
      makeContact('ct-2', 'Gary', 'Keeper', { relationship_role: 'gatekeeper' }),
    ]);
    renderInRouter(<ContactsListView />);
    await waitFor(() => expect(screen.getByText('Dee Maker')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /decision makers/i }));
    await waitFor(() => expect(screen.queryByText('Gary Keeper')).toBeNull());
    expect(screen.getByText('Dee Maker')).toBeInTheDocument();
    expect(lastContactsUrl).toContain('relationship_role=');
  });

  it('the Communication facet refetches and filters server-side', async () => {
    installFetch([
      makeContact('ct-1', 'Open', 'Line', { preference: 'contactable' }),
      makeContact('ct-2', 'No', 'Calls', { preference: 'do_not_contact' }),
    ]);
    renderInRouter(<ContactsListView />);
    await waitFor(() => expect(screen.getByText('Open Line')).toBeInTheDocument());
    const facets = screen.getByRole('complementary', { name: 'Filters' });
    fireEvent.click(within(facets).getByText('Do not contact'));
    await waitFor(() => expect(screen.queryByText('Open Line')).toBeNull());
    expect(screen.getByText('No Calls')).toBeInTheDocument();
  });

  it('Cold-call mode switches to the queue columns and sends cold_callable', async () => {
    installFetch([
      makeContact('ct-1', 'Callable', 'Person', {
        preference: 'contactable', phone_work: '+1 555', last_activity_at: '2026-05-01T00:00:00Z',
      }),
    ]);
    renderInRouter(<ContactsListView />);
    await waitFor(() => expect(screen.getByText('Callable Person')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /cold-call list/i }));
    await waitFor(() => expect(lastContactsUrl).toContain('cold_callable=true'));
    expect(lastContactsUrl).toContain('sort=last_activity');
    const table = screen.getByRole('table');
    expect(within(table).getByText('Work phone')).toBeInTheDocument();
  });

  it('toggles Table/Cards and shows the N of M count', async () => {
    installFetch([
      makeContact('ct-1', 'A', 'One'),
      makeContact('ct-2', 'B', 'Two'),
    ]);
    renderInRouter(<ContactsListView />);
    await waitFor(() => expect(screen.getByText('A One')).toBeInTheDocument());
    expect(screen.getByText(/of 2 contacts/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    expect(screen.getByText('A One')).toBeInTheDocument();
  });

  it('renders (no crash) on the legacy {items}-only shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/v1/tenant/users')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ items: [makeContact('ct-1', 'Legacy', 'Contact')] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    renderInRouter(<ContactsListView />);
    await waitFor(() => expect(screen.getByText('Legacy Contact')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /all contacts/i })).toBeInTheDocument();
  });
});
