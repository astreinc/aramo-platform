import { useSession } from '@aramo/fe-foundation';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMicrosoftMeeting } from '../microsoft/microsoft-api';

import { InterviewDetailView } from './InterviewDetailView';
import {
  associateInterviewMeeting,
  getInterviewSession,
  isTransitionConflict,
  listInterviewFeedback,
  transitionInterview,
} from './interviews-api';
import type { InterviewSessionDetail } from './interviews-api';

const ALL_SCOPES = [
  'client-selection:interview:transition',
  'client-selection:interview:schedule',
  'communication:meeting:create',
  'activity:create',
];

vi.mock('./interviews-api');
vi.mock('../microsoft/microsoft-api', () => ({
  createMicrosoftMeeting: vi.fn(),
}));
vi.mock('../users/users-api', () => ({
  fetchAssignableUsers: vi.fn(async () => []),
  resolveUserNames: vi.fn(async () => ({})),
}));
// Partial mock of fe-foundation: keep the real components + real hasScope, override
// useSession to an authenticated recruiter with the interview scopes.
vi.mock('@aramo/fe-foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aramo/fe-foundation')>();
  return {
    ...actual,
    useSession: vi.fn(() => ({
      status: 'authenticated',
      session: {
        sub: 'u1',
        consumer_type: 'recruiter',
        tenant_id: 't1',
        scopes: ALL_SCOPES,
        iat: 0,
        exp: 0,
      },
    })),
  };
});

const getMock = vi.mocked(getInterviewSession);
const transitionMock = vi.mocked(transitionInterview);
const conflictMock = vi.mocked(isTransitionConflict);
const feedbackMock = vi.mocked(listInterviewFeedback);
const createMeetingMock = vi.mocked(createMicrosoftMeeting);
const associateMock = vi.mocked(associateInterviewMeeting);
const useSessionMock = vi.mocked(useSession);

function authWith(scopes: readonly string[]) {
  return {
    status: 'authenticated' as const,
    session: {
      sub: 'u1',
      consumer_type: 'recruiter' as const,
      tenant_id: 't1',
      scopes: [...scopes],
      iat: 0,
      exp: 0,
    },
  };
}

const MEETING_RESULT = {
  interaction_id: 'mtg1',
  join_url: 'https://teams.example/x',
  scheduled_start: '2026-10-06T15:00:00.000Z',
  scheduled_end: '2026-10-06T16:00:00.000Z',
  talent_record_id: 'tal1',
  requisition_id: 'req1',
  idempotent_replay: false,
};

beforeEach(() => {
  feedbackMock.mockResolvedValue([]);
  useSessionMock.mockReturnValue(authWith(ALL_SCOPES));
});

function detail(over: Partial<InterviewSessionDetail> = {}): InterviewSessionDetail {
  return {
    id: 'iv1',
    tenant_id: 't1',
    client_selection_process_id: 'proc1',
    requisition_id: 'req1',
    talent_record_id: 'tal1',
    site_id: null,
    interview_type: 'onsite',
    round: 1,
    scheduled_at: '2026-10-06T15:00:00.000Z',
    scheduled_end_at: '2026-10-06T16:00:00.000Z',
    timezone: 'America/New_York',
    interviewer_user_ids: [],
    meeting_interaction_id: null,
    state: 'SCHEDULED',
    version: 0,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/interviews/iv1']}>
      <Routes>
        <Route path="/interviews/:sessionId" element={<InterviewDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('InterviewDetailView', () => {
  it('renders the interview + lifecycle actions for a non-terminal session', async () => {
    getMock.mockResolvedValue(detail());
    renderDetail();
    expect(await screen.findByText('Interview · Round 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No-show' })).toBeInTheDocument();
  });

  it('cancel calls the transition command with the current version', async () => {
    getMock.mockResolvedValue(detail({ version: 3 }));
    transitionMock.mockResolvedValue(detail({ state: 'CANCELED', version: 4 }));
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await screen.findByText('Canceled');
    expect(transitionMock).toHaveBeenCalledWith('iv1', {
      to_state: 'CANCELED',
      expected_version: 3,
    });
  });

  it('surfaces the concurrency-conflict prompt on a stale-version transition', async () => {
    getMock.mockResolvedValue(detail());
    transitionMock.mockRejectedValue({ code: 'INTERVIEW_SESSION_TRANSITION_CONFLICT', statusCode: 409 });
    conflictMock.mockReturnValue(true);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Complete' }));
    expect(
      await screen.findByText(/Someone changed this interview/),
    ).toBeInTheDocument();
  });

  it('shows qualitative feedback tied to the interview session (activity substrate)', async () => {
    getMock.mockResolvedValue(detail());
    feedbackMock.mockResolvedValue([
      {
        id: 'f1',
        notes: 'Strong stakeholder examples.',
        created_by_id: 'u1',
        created_at: '2026-10-06T17:00:00.000Z',
        redacted_at: null,
      },
    ]);
    renderDetail();
    expect(
      await screen.findByText('Strong stakeholder examples.'),
    ).toBeInTheDocument();
    expect(feedbackMock).toHaveBeenCalledWith('iv1');
  });

  it('Create Teams meeting → associates the interaction to the interview', async () => {
    getMock.mockResolvedValue(detail({ meeting_interaction_id: null }));
    createMeetingMock.mockResolvedValue(MEETING_RESULT);
    associateMock.mockResolvedValue(
      detail({ meeting_interaction_id: 'mtg1', version: 1 }),
    );
    renderDetail();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create Teams meeting' }),
    );
    expect(await screen.findByText('Teams meeting linked')).toBeInTheDocument();
    expect(createMeetingMock).toHaveBeenCalledTimes(1);
    expect(associateMock).toHaveBeenCalledWith('iv1', {
      expected_version: 0,
      meeting_interaction_id: 'mtg1',
    });
  });

  it('meeting creation failure leaves the interview unchanged (no association attempted)', async () => {
    getMock.mockResolvedValue(detail({ meeting_interaction_id: null }));
    createMeetingMock.mockRejectedValue(new Error('graph down'));
    renderDetail();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create Teams meeting' }),
    );
    expect(await screen.findByText(/Meeting link not created/)).toBeInTheDocument();
    expect(associateMock).not.toHaveBeenCalled();
    expect(screen.getByText('No meeting link')).toBeInTheDocument();
  });

  it('a stale association version surfaces the concurrency-refresh prompt', async () => {
    getMock.mockResolvedValue(detail({ meeting_interaction_id: null }));
    createMeetingMock.mockResolvedValue(MEETING_RESULT);
    associateMock.mockRejectedValue({
      code: 'INTERVIEW_SESSION_TRANSITION_CONFLICT',
      statusCode: 409,
    });
    conflictMock.mockReturnValue(true);
    renderDetail();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create Teams meeting' }),
    );
    expect(
      await screen.findByText(/Someone changed this interview/),
    ).toBeInTheDocument();
  });

  it('hides write actions when the principal lacks the scopes (authorization-hidden)', async () => {
    useSessionMock.mockReturnValue(authWith([]));
    getMock.mockResolvedValue(detail());
    renderDetail();
    await screen.findByText('Interview · Round 1');
    expect(screen.queryByRole('button', { name: 'Reschedule' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create Teams meeting' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Schedule another round' }),
    ).not.toBeInTheDocument();
  });

  it('hides lifecycle actions for a terminal session', async () => {
    getMock.mockResolvedValue(detail({ state: 'COMPLETED' }));
    renderDetail();
    await screen.findByText('Interview · Round 1');
    expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    // Scheduling another round remains available.
    expect(
      screen.getByRole('button', { name: 'Schedule another round' }),
    ).toBeInTheDocument();
  });
});
