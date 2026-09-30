import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InterviewsView } from './InterviewsView';
import { getInterviewCalendar } from './interviews-api';
import type {
  InterviewCalendarRow,
  InterviewCalendarView,
} from './interviews-api';

vi.mock('./interviews-api');
const getMock = vi.mocked(getInterviewCalendar);

function row(over: Partial<InterviewCalendarRow> = {}): InterviewCalendarRow {
  return {
    id: 'iv1',
    scheduled_at: '2026-10-06T15:00:00.000Z',
    scheduled_end_at: '2026-10-06T16:00:00.000Z',
    timezone: 'America/New_York',
    state: 'SCHEDULED',
    round: 1,
    interview_type: 'video',
    talent_record_id: 'tal1',
    talent_name: 'Ada Lovelace',
    requisition_id: 'req1',
    requisition_number: 100,
    requisition_title: 'Backend Eng',
    company_id: 'co1',
    company_name: 'Acme',
    interviewer_user_ids: ['ivr1'],
    version: 0,
    ...over,
  };
}

function view(rows: InterviewCalendarRow[]): InterviewCalendarView {
  return {
    interviews: rows,
    window: { from: '2026-10-05T00:00:00.000Z', to: '2026-10-12T00:00:00.000Z' },
  };
}

function renderView() {
  return render(
    <MemoryRouter>
      <InterviewsView />
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('InterviewsView', () => {
  it('calls GET /v1/interviews on mount and renders an enriched card linking to detail', async () => {
    getMock.mockResolvedValue(view([row()]));
    renderView();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(
      screen.getByText(/REQ-100 · Backend Eng · Acme/),
    ).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Ada Lovelace/ });
    expect(link).toHaveAttribute('href', '/interviews/iv1');
  });

  it('renders an honest empty state when no interviews are scheduled', async () => {
    getMock.mockResolvedValue(view([]));
    renderView();
    expect(
      await screen.findByText(/No interviews are scheduled in this range/),
    ).toBeInTheDocument();
  });

  it('applies requisition_id + talent_id filters from the URL (journey deep-link)', async () => {
    getMock.mockResolvedValue(view([row()]));
    render(
      <MemoryRouter initialEntries={['/interviews?requisition_id=req1&talent_id=tal1']}>
        <InterviewsView />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({ requisition_id: 'req1', talent_id: 'tal1' }),
    );
  });

  it('surfaces an error with a Retry that refetches', async () => {
    getMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(view([row()]));
    renderView();
    const retry = await screen.findByRole('button', { name: /Retry/ });
    fireEvent.click(retry);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
