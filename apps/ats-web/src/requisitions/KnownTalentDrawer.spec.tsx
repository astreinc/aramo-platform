import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KnownTalentDrawer } from './KnownTalentDrawer';
import type { RequisitionView } from './types';

// CRM-8 (§12) — the Known Talent drawer composes the live talent search +
// CRM-3/4 composition and reuses the existing Pipeline add authority.
const h = vi.hoisted(() => ({
  searchTalent: vi.fn(),
  listTalentMemberships: vi.fn(),
  resolveUserNames: vi.fn(),
  addTalentToPipeline: vi.fn(),
}));
vi.mock('../talent/talent-api', () => ({ searchTalent: h.searchTalent }));
vi.mock('../talent/saved-list-api', async (actual) => ({
  ...(await actual<typeof import('../talent/saved-list-api')>()),
  listTalentMemberships: h.listTalentMemberships,
}));
vi.mock('../users/users-api', () => ({ resolveUserNames: h.resolveUserNames }));
vi.mock('../pipeline/pipeline-api', () => ({ addTalentToPipeline: h.addTalentToPipeline }));
vi.mock('@aramo/fe-foundation', async (actual) => {
  const a = await actual<typeof import('@aramo/fe-foundation')>();
  return {
    ...a,
    useSession: () => ({
      status: 'authenticated' as const,
      session: { sub: 'u1', consumer_type: 'recruiter' as const, tenant_id: 't', scopes: ['talent:read'], iat: 0, exp: 9_999_999_999 },
    }),
  };
});

const REQ = { id: 'r1', title: 'Business Analyst', city: 'Washington', state: 'DC', work_arrangement: 'hybrid' } as unknown as RequisitionView;

const talent = (id: string, first: string, last: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: 't', site_id: null, first_name: first, last_name: last,
  email1: `${first}@x.test`, phone_cell: '703', city: 'Washington', state: 'DC',
  title: 'Business Analyst', key_skills: 'SQL', current_pay: null, desired_pay: null,
  availability_status: 'available_now', engagement_type: 'contract', source: null,
  is_hot: false, owner_id: null, work_authorization: null, consent_summary: 'contactable',
  current_stage: null, last_activity_at: null, record_status: 'live', last_contact: null,
  ...over,
});

function renderDrawer(attached: string[] = [], canAdd = true) {
  return render(
    <MemoryRouter>
      <KnownTalentDrawer
        requisition={REQ}
        attachedTalentIds={attached}
        canAddToRequisition={canAdd}
        onClose={() => undefined}
        onAdded={() => undefined}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  h.searchTalent.mockResolvedValue({ items: [talent('1', 'Ada', 'Lovelace'), talent('2', 'Bob', 'Khan')], next_cursor: null, facets: {} });
  h.listTalentMemberships.mockResolvedValue([{ item_id: '1', lists: [{ id: 'L1', name: 'Hot BA', visibility: 'tenant' }] }]);
  h.resolveUserNames.mockResolvedValue({});
  h.addTalentToPipeline.mockResolvedValue({ id: 'p1' });
});
afterEach(() => vi.clearAllMocks());

describe('KnownTalentDrawer (CRM-8 §12)', () => {
  it('opens requisition-scoped: title + location chips, composed into the talent search (not global redirect)', async () => {
    renderDrawer();
    await screen.findByText('Ada Lovelace');
    // chips from requisition facts.
    expect(screen.getByRole('button', { name: /Remove filter Business Analyst/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove filter Washington, DC/ })).toBeInTheDocument();
    // the search was composed from the chips (requisition-scoped, reusing /v1/talent-records).
    const params = h.searchTalent.mock.calls[0]![0] as URLSearchParams;
    expect(params.get('paged')).toBe('true');
    expect(params.get('q')).toContain('Business Analyst');
  });

  it('composes result fields + a FACTUAL "Matched on" (no numeric ordinal), and list membership', async () => {
    renderDrawer();
    await screen.findByText('Ada Lovelace');
    expect(screen.getAllByText(/Matched on:/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Business Analyst/).length).toBeGreaterThan(0); // matched term shown
    expect(screen.getByText('Hot BA')).toBeInTheDocument(); // CRM-3 membership composed
  });

  it('§12.4 mutually exclusive: attached → "On this requisition" (no duplicate add); not attached → Add to requisition', async () => {
    renderDrawer(['1']); // talent 1 already attached
    await screen.findByText('Ada Lovelace');
    const adaRow = screen.getByText('Ada Lovelace').closest('.rc-ktd__row') as HTMLElement;
    const bobRow = screen.getByText('Bob Khan').closest('.rc-ktd__row') as HTMLElement;
    expect(within(adaRow).getByText('✓ On this requisition')).toBeInTheDocument();
    expect(within(adaRow).queryByRole('button', { name: 'Add to requisition' })).toBeNull();
    expect(within(bobRow).getByRole('button', { name: 'Add to requisition' })).toBeInTheDocument();
  });

  it('Add to requisition reuses the existing Pipeline add authority', async () => {
    renderDrawer();
    await screen.findByText('Bob Khan');
    const bobRow = screen.getByText('Bob Khan').closest('.rc-ktd__row') as HTMLElement;
    fireEvent.click(within(bobRow).getByRole('button', { name: 'Add to requisition' }));
    await waitFor(() => expect(h.addTalentToPipeline).toHaveBeenCalledWith('2', 'r1'));
  });

  it('§12.5 offers "Source new talent" routing to Sourcing (unchanged)', async () => {
    renderDrawer();
    await screen.findByText('Ada Lovelace');
    expect(screen.getByRole('link', { name: /Source new talent/ })).toHaveAttribute('href', '/sourcing');
  });

  it('hides Add to requisition when the actor cannot add (no fabricated affordance)', async () => {
    renderDrawer([], false);
    await screen.findByText('Bob Khan');
    expect(screen.queryByRole('button', { name: 'Add to requisition' })).toBeNull();
  });
});
