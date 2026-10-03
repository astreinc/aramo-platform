import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';

import { scheduleInterview } from '../interviews/interviews-api';

import { ClientSelectionActionDialog, ScheduleInterviewDialog } from './ClientResponseDialogs';
import { decideClientSelection, transitionClientSelection } from './client-selection-api';

// vi.mock hoisted above imports by vitest.
vi.mock('./client-selection-api', () => ({ transitionClientSelection: vi.fn(), decideClientSelection: vi.fn() }));
vi.mock('../interviews/interviews-api', () => ({ scheduleInterview: vi.fn() }));

const transitionMock = vi.mocked(transitionClientSelection);
const decideMock = vi.mocked(decideClientSelection);
const scheduleMock = vi.mocked(scheduleInterview);

describe('ClientSelectionActionDialog (governed transition/decision; CAS via version)', () => {
  beforeEach(() => vi.clearAllMocks());

  const base = { open: true as const, onOpenChange: vi.fn(), processId: 'csp1', version: 4 };

  it('move_to_interview → /transition to_state INTERVIEW with expected_version; onDone', async () => {
    transitionMock.mockResolvedValue({ id: 'csp1', state: 'INTERVIEW', version: 5 });
    const onDone = vi.fn(); const onConflict = vi.fn();
    render(<ClientSelectionActionDialog {...base} kind="move_to_interview" onDone={onDone} onConflict={onConflict} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move to interview' }));
    await waitFor(() => expect(transitionMock).toHaveBeenCalledWith('csp1', { to_state: 'INTERVIEW', expected_version: 4, note: undefined }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('mark_selected → /transition to_state SELECTED', async () => {
    transitionMock.mockResolvedValue({ id: 'csp1', state: 'SELECTED', version: 5 });
    render(<ClientSelectionActionDialog {...base} kind="mark_selected" onDone={vi.fn()} onConflict={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record selected' }));
    await waitFor(() => expect(transitionMock).toHaveBeenCalledWith('csp1', { to_state: 'SELECTED', expected_version: 4, note: undefined }));
  });

  it('decline → /decision to_state DECLINED (note optional)', async () => {
    decideMock.mockResolvedValue({ id: 'csp1', state: 'DECLINED', version: 5 });
    render(<ClientSelectionActionDialog {...base} kind="decline" onDone={vi.fn()} onConflict={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record declined' }));
    await waitFor(() => expect(decideMock).toHaveBeenCalledWith('csp1', { to_state: 'DECLINED', expected_version: 4, note: undefined }));
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('withdraw → /decision to_state WITHDRAWN with a closed reason_code', async () => {
    decideMock.mockResolvedValue({ id: 'csp1', state: 'WITHDRAWN', version: 5 });
    render(<ClientSelectionActionDialog {...base} kind="withdraw" onDone={vi.fn()} onConflict={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(decideMock).toHaveBeenCalledWith('csp1', { to_state: 'WITHDRAWN', expected_version: 4, reason_code: 'TALENT_WITHDREW', note: undefined }));
  });

  it('CAS conflict (CLIENT_SELECTION_TRANSITION_CONFLICT) → onConflict, never onDone', async () => {
    transitionMock.mockRejectedValue(new ApiError(409, 'stale', 'CLIENT_SELECTION_TRANSITION_CONFLICT'));
    const onDone = vi.fn(); const onConflict = vi.fn();
    render(<ClientSelectionActionDialog {...base} kind="mark_selected" onDone={onDone} onConflict={onConflict} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record selected' }));
    await waitFor(() => expect(onConflict).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('ScheduleInterviewDialog (reuses the governed schedule contract)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('schedules an interview with the chosen round + ISO scheduled_at; onDone', async () => {
    scheduleMock.mockResolvedValue({ id: 'iv1' } as never);
    const onDone = vi.fn();
    render(<ScheduleInterviewDialog open onOpenChange={vi.fn()} processId="csp1" defaultRound={1} onDone={onDone} onConflict={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Schedule interview' }));
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1));
    const [pid, body] = scheduleMock.mock.calls[0];
    expect(pid).toBe('csp1');
    expect(body.interview_type).toBe('Client interview');
    expect(body.round).toBe(1);
    expect(typeof body.scheduled_at).toBe('string');
    expect(() => new Date(body.scheduled_at).toISOString()).not.toThrow();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
