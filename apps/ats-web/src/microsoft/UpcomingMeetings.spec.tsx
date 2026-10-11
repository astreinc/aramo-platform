import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { UpcomingMeetings } from './UpcomingMeetings';
import type { ScheduledMeetingView } from './microsoft-api';

function view(over: Partial<ScheduledMeetingView> = {}): ScheduledMeetingView {
  return {
    interaction_id: 'int-1', operation_id: null, provider_event_id: 'evt-1',
    join_url: 'https://teams.example/join', status: 'scheduled', version: 1,
    scheduled_start: '2026-11-03T15:00:00.000Z', scheduled_end: '2026-11-03T15:30:00.000Z',
    idempotent_replay: false, ...over,
  };
}

function renderList(props: Partial<React.ComponentProps<typeof UpcomingMeetings>> = {}) {
  return render(
    <MemoryRouter>
      <UpcomingMeetings
        talentId="tal-1"
        talentName="Dana Lee"
        canEdit
        canCancel
        listFn={vi.fn().mockResolvedValue({ meetings: [view()] })}
        cancelFn={vi.fn().mockResolvedValue(view({ status: 'cancelled' }))}
        onReschedule={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('UpcomingMeetings', () => {
  it('renders upcoming rows with a Join link; copy states last-known state and does NOT promise automatic Outlook sync', async () => {
    renderList();
    expect(await screen.findByTestId('upcoming-meeting-int-1')).toBeInTheDocument();
    expect(screen.getByTestId('upcoming-join-int-1')).toHaveAttribute('href', 'https://teams.example/join');
    const block = screen.getByTestId('upcoming-meetings');
    expect(block.textContent).toMatch(/last-known/i);
    expect(block.textContent).not.toMatch(/changes made in outlook (show up|appear) here|automatically/i);
  });

  it('Reschedule invokes onReschedule with the meeting view', async () => {
    const onReschedule = vi.fn();
    renderList({ onReschedule });
    fireEvent.click(await screen.findByTestId('upcoming-reschedule-int-1'));
    expect(onReschedule).toHaveBeenCalledTimes(1);
    expect(onReschedule.mock.calls[0][0].interaction_id).toBe('int-1');
  });

  it('Cancel requires confirmation, then calls cancelFn with expected_version', async () => {
    const cancelFn = vi.fn().mockResolvedValue(view({ status: 'cancelled' }));
    renderList({ cancelFn });
    fireEvent.click(await screen.findByTestId('upcoming-cancel-int-1'));
    expect(cancelFn).not.toHaveBeenCalled(); // confirmation gate
    fireEvent.click(await screen.findByTestId('upcoming-cancel-confirm'));
    await waitFor(() => expect(cancelFn).toHaveBeenCalledTimes(1));
    expect(cancelFn.mock.calls[0][0]).toBe('int-1');
    expect(cancelFn.mock.calls[0][1].expected_version).toBe(1);
  });

  it('scope gating: without edit/cancel, those controls are absent', async () => {
    renderList({ canEdit: false, canCancel: false });
    await screen.findByTestId('upcoming-meeting-int-1');
    expect(screen.queryByTestId('upcoming-reschedule-int-1')).toBeNull();
    expect(screen.queryByTestId('upcoming-cancel-int-1')).toBeNull();
  });

  it('an UNKNOWN status is handled conservatively — not shown as scheduled, no Join/Reschedule/Cancel', async () => {
    renderList({ listFn: vi.fn().mockResolvedValue({ meetings: [view({ status: 'provider_pending_weird', join_url: null })] }) });
    await screen.findByTestId('upcoming-meeting-int-1');
    expect(screen.queryByTestId('upcoming-join-int-1')).toBeNull();
    expect(screen.queryByTestId('upcoming-reschedule-int-1')).toBeNull();
    expect(screen.queryByTestId('upcoming-cancel-int-1')).toBeNull();
    expect(screen.getByTestId('upcoming-meeting-int-1').textContent).not.toMatch(/\bscheduled\b/i);
  });

  it('empty state when there are no upcoming meetings', async () => {
    renderList({ listFn: vi.fn().mockResolvedValue({ meetings: [] }) });
    expect(await screen.findByTestId('upcoming-empty')).toBeInTheDocument();
  });

  it('FIX_NOW-4: a failed read shows a distinct error state (NOT empty), with retry that recovers', async () => {
    const listFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ meetings: [view()] });
    renderList({ listFn });
    expect(await screen.findByTestId('upcoming-load-error')).toBeInTheDocument();
    // a read failure must never be presented as "no meetings"
    expect(screen.queryByTestId('upcoming-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('upcoming-retry'));
    expect(await screen.findByTestId('upcoming-meeting-int-1')).toBeInTheDocument();
    expect(screen.queryByTestId('upcoming-load-error')).toBeNull();
  });
});
