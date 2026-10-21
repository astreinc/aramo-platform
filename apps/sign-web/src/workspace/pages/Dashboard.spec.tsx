import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// Dashboard banner handoff rev. 2 §1 / acceptance 1: the time-of-day greeting is
// gone, the banner leads the page, and Quick actions keeps only the two links the
// banner does not offer (Awaiting signatures, Recent activity).

vi.mock('../api', async (orig) => {
  const mod = await orig<typeof import('../api')>();
  return {
    ...mod,
    senderApi: {
      ...mod.senderApi,
      summary: async () => ({
        awaiting_signatures: 0,
        counts: { draft: 0 },
        completed_this_month: 0,
        declined_or_expired: 0,
        completion_rate: null,
        months: [],
        expiring_soon: [],
      }),
      list: async () => ({ items: [] }),
    },
  };
});
vi.mock('../workspace', () => ({
  useWorkspace: () => ({
    base: '/sign',
    ctx: { can_send: true, workspace: 'sign', user: { id: 'u-1', email: null, display_name: 'Purush Pichaimuthu' } },
    toast: vi.fn(),
  }),
}));

import { Dashboard } from './Dashboard';

describe('Dashboard', () => {
  it('leads with the banner and trims Quick actions to the two non-duplicated links', async () => {
    render(
      <MemoryRouter initialEntries={['/sign']}>
        <Dashboard />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Welcome back, Purush Pichaimuthu']);
    expect(screen.queryByText(/Good (morning|afternoon|evening)/)).toBeNull();
    expect(screen.queryByText(/what’s happening/)).toBeNull();
    const card = (await screen.findByText('Quick actions')).closest('section') as HTMLElement;
    expect(within(card).getAllByRole('link').map((a) => a.textContent)).toEqual(['Awaiting signatures', 'Recent activity']);
  });
});
