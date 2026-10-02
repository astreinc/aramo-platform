import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ListsPanel } from './ListsPanel';

// CRM-3 — the in-tab Lists surface: INDEX (five columns, authoritative
// member_count + visibility labels + roster-resolved creator) → DETAIL (batch
// Talent rows via ?ids=, governed Add-to-requisition, Remove entry only).

const SESSION = {
  sub: 'u1',
  consumer_type: 'recruiter' as const,
  tenant_id: 't',
  scopes: ['talent:read', 'saved-list:read', 'saved-list:edit', 'pipeline:add'],
  iat: 0,
  exp: 0,
};

const LIST = {
  id: 'L1',
  tenant_id: 't',
  site_id: null,
  owner_id: 'u-owner',
  name: 'Hot React',
  item_type: 'talent_record',
  visibility: 'tenant',
  purpose: 'Priority bench',
  member_count: 2,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-30T00:00:00.000Z',
};

const talent = (id: string, first: string, last: string) => ({
  id, tenant_id: 't', site_id: null, first_name: first, last_name: last,
  email1: `${first}@x.test`, phone_cell: '703', city: 'Vienna', state: 'VA',
  title: 'Scrum Master', key_skills: 'Agile', current_pay: null, desired_pay: null,
  availability_status: 'available_now', engagement_type: 'contract', source: null,
  is_hot: false, owner_id: null, work_authorization: null, consent_summary: 'contactable',
  current_stage: null, last_activity_at: null, record_status: 'live',
});

function mockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/v1/tenant/users'))
      return json({ items: [{ user_id: 'u-owner', email: 'o@x.test', display_name: 'Tom Owner', is_active: true }] });
    if (url.includes('/v1/saved-lists/memberships')) return json({ items: [] });
    if (/\/v1\/saved-lists\/L1(\?|$)/.test(url))
      return json({ ...LIST, entries: [
        { id: 'e1', tenant_id: 't', saved_list_id: 'L1', item_type: 'talent_record', item_id: '1', created_at: '' },
        { id: 'e2', tenant_id: 't', saved_list_id: 'L1', item_type: 'talent_record', item_id: '2', created_at: '' },
      ] });
    if (url.includes('/v1/saved-lists')) return json({ items: [LIST] });
    if (url.includes('/v1/talent-records'))
      return json({ items: [talent('1', 'Ada', 'Lovelace'), talent('2', 'Bob', 'Khan')], next_cursor: null, facets: {} });
    return json({ items: [] });
  });
}

function renderPanel() {
  mockFetch();
  render(
    <MemoryRouter>
      <ListsPanel sessionOverride={SESSION} />
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('ListsPanel (CRM-3)', () => {
  it('renders the Lists index with name/purpose, visibility label, member_count and resolved creator', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('Hot React')).toBeInTheDocument());
    expect(screen.getByText('Priority bench')).toBeInTheDocument();
    expect(screen.getByText('Shared with tenant')).toBeInTheDocument(); // visibility label
    expect(screen.getByText('2')).toBeInTheDocument(); // member_count
    expect(screen.getByText('Tom Owner')).toBeInTheDocument(); // created-by, roster-resolved
  });

  it('opens the detail (batch Talent rows) with Remove + Add to requisition', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('Hot React')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Hot React'));
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(screen.getByText('Bob Khan')).toBeInTheDocument();
    // governed actions present (scopes held)
    expect(screen.getAllByRole('button', { name: /add to requisition/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^remove$/i }).length).toBe(2);
    // last-contacted stays "—" (CRM-4); never proxied by activity.
    const rows = screen.getAllByRole('row');
    expect(within(rows[rows.length - 1]!).getByText('—')).toBeInTheDocument();
  });
});
