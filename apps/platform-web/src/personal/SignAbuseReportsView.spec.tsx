import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformApi, type SignAbuseQueueItem } from '../platform-api';

import { SignAbuseReportsView } from './SignAbuseReportsView';

// Aramo-Sign-Mobile-Amendment-M-A7 §5.2 (R-11) — reports from Business senders are
// routed to Aramo operators: the queue lists them (with the sender) and an operator
// records an outcome with a reason.

const BUSINESS: SignAbuseQueueItem = {
  id: 'r-b',
  envelope_id: 'e-1',
  reason: 'phishing',
  note: 'asked for a bank login',
  reporter_domain: 'example.org',
  weight: 3,
  triggered_restriction: false,
  outcome: 'OPEN',
  outcome_reason: null,
  decided_at: null,
  created_at: '2026-10-28T00:00:00Z',
  tenant_id: 't-b',
  sender_kind: 'BUSINESS',
  sender_name: 'Acme Staffing',
};

afterEach(() => vi.restoreAllMocks());

describe('SignAbuseReportsView', () => {
  it('lists open reports with the sender (Business) and records a decision with a reason', async () => {
    const list = vi.spyOn(platformApi, 'listSignAbuseReports').mockResolvedValue({ items: [BUSINESS] });
    const decide = vi.spyOn(platformApi, 'decidePersonalReport').mockResolvedValue({ ...BUSINESS, outcome: 'CONFIRMED' });
    render(
      <MemoryRouter>
        <SignAbuseReportsView />
      </MemoryRouter>,
    );
    const row = await screen.findByTestId('sign-abuse-report-r-b');
    expect(list).toHaveBeenCalledWith('OPEN');
    expect(within(row).getByTestId('sign-abuse-sender')).toHaveTextContent('Business · Acme Staffing');
    expect(within(row).getByText('“asked for a bank login”')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm report' });
    const commit = within(dialog).getByRole('button', { name: 'Confirm report' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'confirmed phishing' } });
    fireEvent.click(commit);
    await waitFor(() => expect(decide).toHaveBeenCalledWith('r-b', { outcome: 'CONFIRMED', reason: 'confirmed phishing' }));
  });

  it('All shows every outcome; an empty queue says so', async () => {
    const list = vi.spyOn(platformApi, 'listSignAbuseReports').mockResolvedValue({ items: [] });
    render(
      <MemoryRouter>
        <SignAbuseReportsView />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No open reports')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(undefined));
    expect(await screen.findByText('No reports')).toBeInTheDocument();
  });
});
