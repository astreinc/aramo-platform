import { type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { OfferStartWorklistView } from './OfferStartWorklistView';
import type { OfferStartWorklistRow } from './offer-start-worklist-api';

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}
const READ = makeSession(['pipeline:read']);
const NO_READ = makeSession(['requisition:read']);

function row(over: Partial<OfferStartWorklistRow> = {}): OfferStartWorklistRow {
  return {
    pipeline_id: 'pl-1', requisition_id: 'r1', requisition_number: 101, requisition_title: 'Senior BA',
    client_name: 'Freddie Mac', talent_record_id: 't1', talent_name: 'Aisha Khan', phase: 'OFFER',
    phase_label: 'Offer sent', engagement: 'CONTRACT', has_exception: false, exception_summary: null,
    updated_at: '2026-10-02T00:00:00.000Z', ...over,
  };
}

function renderView(session: Session, items: readonly OfferStartWorklistRow[]) {
  const getFn = vi.fn().mockResolvedValue({ items, total: items.length });
  render(
    <MemoryRouter>
      <OfferStartWorklistView sessionOverride={session} getWorklistFn={getFn} />
    </MemoryRouter>,
  );
  return getFn;
}

describe('OfferStartWorklistView — cross-requisition Offer & Start worklist (§9)', () => {
  it('renders the server-composed rows; each deep-links to the SAME journey at /offer-start/:pipeline_id', async () => {
    renderView(READ, [row({ pipeline_id: 'pl-7', talent_record_id: 't7', talent_name: 'Aisha Khan', phase_label: 'Awaiting signature' })]);
    await waitFor(() => expect(screen.getByTestId('offer-start-worklist')).toBeTruthy());
    const link = within(screen.getByTestId('worklist-row-t7')).getByText('Aisha Khan').closest('a');
    expect(link).toHaveAttribute('href', '/offer-start/pl-7');
    expect(screen.getByTestId('worklist-phase-t7').textContent).toContain('Awaiting signature');
  });

  it('is gated by pipeline:read (not placement:read) — a row may have no placement yet', () => {
    const getFn = vi.fn().mockResolvedValue({ items: [], total: 0 });
    render(<MemoryRouter><OfferStartWorklistView sessionOverride={NO_READ} getWorklistFn={getFn} /></MemoryRouter>);
    // No pipeline:read ⇒ the container renders nothing and never issues the read.
    expect(screen.queryByTestId('offer-start-worklist')).toBeNull();
    expect(getFn).not.toHaveBeenCalled();
  });

  it('a no-placement OFFER row still deep-links (pre-PlacementProcess people are in scope, §9.1)', async () => {
    renderView(READ, [row({ pipeline_id: 'pl-9', talent_record_id: 't9', talent_name: 'Nora Diaz', phase: 'ACCEPTED', phase_label: 'Offer accepted' })]);
    await waitFor(() => expect(screen.getByTestId('worklist-row-t9')).toBeTruthy());
    expect(within(screen.getByTestId('worklist-row-t9')).getByText('Nora Diaz').closest('a')).toHaveAttribute('href', '/offer-start/pl-9');
  });

  it('an unresolvable episode (pipeline_id null) renders the row WITHOUT a deep-link (never guesses a key)', async () => {
    renderView(READ, [row({ pipeline_id: null, talent_record_id: 't5', talent_name: 'Samuel Lee' })]);
    await waitFor(() => expect(screen.getByTestId('worklist-row-t5')).toBeTruthy());
    expect(within(screen.getByTestId('worklist-row-t5')).queryByRole('link')).toBeNull();
  });

  it('empty worklist → the empty-state message (never an error)', async () => {
    renderView(READ, []);
    await waitFor(() => expect(screen.getByText('No one is in the Offer → Start journey yet.')).toBeTruthy());
  });

  it('a getWorklist failure surfaces the error state, not a crash', async () => {
    const getFn = vi.fn().mockRejectedValue(new Error('boom'));
    render(<MemoryRouter><OfferStartWorklistView sessionOverride={READ} getWorklistFn={getFn} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Could not load the Offer/)).toBeTruthy());
  });
});
