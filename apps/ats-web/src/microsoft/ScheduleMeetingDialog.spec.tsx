import { ApiError } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ScheduleMeetingDialog } from './ScheduleMeetingDialog';
import type { ScheduledMeetingView } from './microsoft-api';

const VIEW: ScheduledMeetingView = {
  interaction_id: 'int-1',
  operation_id: 'op-1',
  provider_event_id: 'evt-1',
  join_url: 'https://teams.example/join',
  status: 'scheduled',
  version: 0,
  scheduled_start: '2026-11-03T15:00:00.000Z',
  scheduled_end: '2026-11-03T15:30:00.000Z',
  idempotent_replay: false,
};

function fillValidForm(): void {
  fireEvent.change(screen.getByTestId('schedule-date'), { target: { value: '2026-11-03' } });
  fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '10:00' } });
  fireEvent.change(screen.getByTestId('schedule-subject'), { target: { value: 'Recruiter screen' } });
}

describe('ScheduleMeetingDialog', () => {
  it('review-before-send: submitting the form shows a review; it does NOT call the API on open or on review', async () => {
    const scheduleFn = vi.fn().mockResolvedValue(VIEW);
    render(
      <ScheduleMeetingDialog
        open
        onOpenChange={vi.fn()}
        talentId="tal-1"
        talentName="Dana Lee"
        requisitionId="req-1"
        scheduleFn={scheduleFn}
        onDone={vi.fn()}
      />,
    );
    // opening the dialog must never transmit
    expect(scheduleFn).not.toHaveBeenCalled();
    fillValidForm();
    fireEvent.click(screen.getByTestId('schedule-review'));
    // a review summary appears; still no API call
    expect(await screen.findByTestId('schedule-review-summary')).toBeInTheDocument();
    expect(screen.getByTestId('schedule-review-summary').textContent).toMatch(/invitation/i);
    expect(scheduleFn).not.toHaveBeenCalled();
  });

  it('confirming the review calls scheduleFn with a composed DTO incl. a non-empty IANA time_zone and idempotency_key', async () => {
    const scheduleFn = vi.fn().mockResolvedValue(VIEW);
    const onDone = vi.fn();
    render(
      <ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" pipelineId="pl-1" scheduleFn={scheduleFn} onDone={onDone} />,
    );
    fillValidForm();
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(scheduleFn).toHaveBeenCalledTimes(1));
    const dto = scheduleFn.mock.calls[0][0];
    expect(dto.talent_record_id).toBe('tal-1');
    expect(dto.requisition_id).toBe('req-1');
    expect(dto.pipeline_id).toBe('pl-1');
    expect(dto.subject).toBe('Recruiter screen');
    expect(typeof dto.time_zone).toBe('string');
    expect(dto.time_zone.length).toBeGreaterThan(0); // validated IANA, never empty
    expect(dto.idempotency_key.length).toBeGreaterThanOrEqual(8);
    expect(dto.start_date_time).toMatch(/2026-11-03T10:00/);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(VIEW));
  });

  it('idempotency key is STABLE across a failed-then-retry of an unchanged request', async () => {
    const scheduleFn = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(502, 'x', 'MICROSOFT_PROVIDER_ERROR'))
      .mockResolvedValueOnce(VIEW);
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" scheduleFn={scheduleFn} onDone={vi.fn()} />);
    fillValidForm();
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(scheduleFn).toHaveBeenCalledTimes(1));
    // retry the SAME unchanged request
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(scheduleFn).toHaveBeenCalledTimes(2));
    expect(scheduleFn.mock.calls[0][0].idempotency_key).toBe(scheduleFn.mock.calls[1][0].idempotency_key);
  });

  it('timezone is a validated selection (a <select>), never a free-text input', () => {
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" scheduleFn={vi.fn()} onDone={vi.fn()} />);
    const tz = screen.getByTestId('schedule-timezone');
    expect(tz.tagName).toBe('SELECT');
    expect((tz as HTMLSelectElement).value.length).toBeGreaterThan(0); // a concrete default IANA zone
  });

  it('edit mode calls rescheduleFn with expected_version from the meeting', async () => {
    const rescheduleFn = vi.fn().mockResolvedValue({ ...VIEW, status: 'rescheduled', version: 1 });
    render(
      <ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" editing={VIEW} rescheduleFn={rescheduleFn} onDone={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('schedule-time'), { target: { value: '11:00' } });
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    await waitFor(() => expect(rescheduleFn).toHaveBeenCalledTimes(1));
    expect(rescheduleFn.mock.calls[0][0]).toBe('int-1');
    expect(rescheduleFn.mock.calls[0][1].expected_version).toBe(0);
  });

  it('an UNRESOLVED error shows the uncertain-outcome message and offers NO retry', async () => {
    const scheduleFn = vi
      .fn()
      .mockRejectedValue(new ApiError(409, 'x', 'MICROSOFT_SCHEDULING_UNRESOLVED', { operation_id: 'op-x' }));
    render(<ScheduleMeetingDialog open onOpenChange={vi.fn()} talentId="tal-1" requisitionId="req-1" scheduleFn={scheduleFn} onDone={vi.fn()} />);
    fillValidForm();
    fireEvent.click(screen.getByTestId('schedule-review'));
    fireEvent.click(await screen.findByTestId('schedule-confirm'));
    const err = await screen.findByTestId('schedule-error');
    expect(err.textContent).toMatch(/could not be confirmed|not confirmed/i);
    expect(err.textContent).toMatch(/op-x/);
    expect(screen.queryByTestId('schedule-confirm')).toBeNull(); // no blind retry affordance
  });
});
