import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MicrosoftRecruiterActions } from './MicrosoftRecruiterActions';
import type { MicrosoftBindingStatus } from './microsoft-api';

// COMM-C2B recruiter UX proofs: reauthorization gating + truthful evidence
// language ("email sent"/"meeting link created" — never "responded"/"attended").

function status(over: Partial<MicrosoftBindingStatus>): MicrosoftBindingStatus {
  return { connection_id: 'c1', bound: true, status: 'active', needs_reauthorization: false, ...over };
}

describe('MicrosoftRecruiterActions', () => {
  it('shows the reauthorization prompt when the identity needs (re)authorization', async () => {
    const onNavigate = vi.fn();
    render(
      <MicrosoftRecruiterActions
        talentId="t1"
        requisitionId="r1"
        loadStatusFn={vi.fn().mockResolvedValue(status({ bound: false, status: 'reauth_required', needs_reauthorization: true }))}
        startAuthorizeFn={vi.fn().mockResolvedValue({ authorize_url: 'https://login.microsoftonline.example/x' })}
        onNavigate={onNavigate}
      />,
    );
    const btn = await screen.findByTestId('microsoft-authorize-button');
    fireEvent.click(btn);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('https://login.microsoftonline.example/x'));
  });

  it('sends email and shows an accepted-delivery (NOT responded) confirmation', async () => {
    const sendEmailFn = vi.fn().mockResolvedValue({
      interaction_id: 'i1',
      status: 'accepted',
      talent_record_id: 't1',
      requisition_id: 'r1',
      idempotent_replay: false,
    });
    render(
      <MicrosoftRecruiterActions
        talentId="t1"
        requisitionId="r1"
        toEmail="talent@example.test"
        loadStatusFn={vi.fn().mockResolvedValue(status({}))}
        sendEmailFn={sendEmailFn}
      />,
    );
    fireEvent.click(await screen.findByTestId('microsoft-send-email'));
    const sent = await screen.findByTestId('microsoft-email-sent');
    expect(sent.textContent).toMatch(/accepted/i);
    expect(sent.textContent).not.toMatch(/responded|replied/i);
    expect(sendEmailFn).toHaveBeenCalledTimes(1);
  });

  it('creates a Teams meeting and surfaces the join link (create-link-only, not attendance)', async () => {
    const createMeetingFn = vi.fn().mockResolvedValue({
      interaction_id: 'i2',
      join_url: 'https://teams.microsoft.example/l/join',
      scheduled_start: '2026-09-10T15:00:00.000Z',
      scheduled_end: '2026-09-10T15:30:00.000Z',
      talent_record_id: 't1',
      requisition_id: 'r1',
      idempotent_replay: false,
    });
    render(
      <MicrosoftRecruiterActions
        talentId="t1"
        requisitionId="r1"
        loadStatusFn={vi.fn().mockResolvedValue(status({}))}
        createMeetingFn={createMeetingFn}
      />,
    );
    fireEvent.click(await screen.findByTestId('microsoft-create-meeting'));
    const created = await screen.findByTestId('microsoft-meeting-created');
    expect(created.textContent).toMatch(/link created/i);
    expect(created.textContent).not.toMatch(/attended|completed/i);
    expect(await screen.findByTestId('microsoft-meeting-join-url')).toHaveAttribute(
      'href',
      'https://teams.microsoft.example/l/join',
    );
  });
});
