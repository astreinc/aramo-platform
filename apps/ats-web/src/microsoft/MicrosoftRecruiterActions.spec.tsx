import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { MicrosoftRecruiterActions } from './MicrosoftRecruiterActions';
import type { MicrosoftBindingStatus } from './microsoft-api';

// COMM-C2B recruiter UX proofs: connect-gating (the per-user mailbox connect
// now lives in My Settings — the panel LINKS there, never hosts authorize) +
// truthful evidence language ("email sent"/"meeting link created" — never
// "responded"/"attended").

function status(over: Partial<MicrosoftBindingStatus>): MicrosoftBindingStatus {
  return { connection_id: 'c1', bound: true, status: 'active', needs_reauthorization: false, ...over };
}
function renderR(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('MicrosoftRecruiterActions', () => {
  it('not connected → links to My Settings to connect (no authorize button on the Talent panel)', async () => {
    renderR(
      <MicrosoftRecruiterActions
        talentId="t1"
        requisitionId="r1"
        loadStatusFn={vi.fn().mockResolvedValue(status({ bound: false, status: 'reauth_required', needs_reauthorization: true }))}
      />,
    );
    const link = await screen.findByTestId('microsoft-connect-link');
    expect(link).toHaveAttribute('href', '/settings/me');
    expect(screen.queryByTestId('microsoft-authorize-button')).toBeNull();
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
