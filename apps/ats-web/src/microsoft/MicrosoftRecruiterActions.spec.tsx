import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { MicrosoftRecruiterActions } from './MicrosoftRecruiterActions';
import type { MicrosoftBindingStatus, RequisitionContactDraft } from './microsoft-api';

// COMM-C2B recruiter UX proofs: connect-gating (the per-user mailbox connect now
// lives in My Settings) + truthful evidence language. COMM-C4 PR-2: "Send email"
// opens the compose/review composer (INV-1) — it never one-click-transmits — and
// the affordance is scope-gated (least-visibility).

function status(over: Partial<MicrosoftBindingStatus>): MicrosoftBindingStatus {
  return { connection_id: 'c1', bound: true, status: 'active', needs_reauthorization: false, ...over };
}
function draft(over: Partial<RequisitionContactDraft> = {}): RequisitionContactDraft {
  return {
    to: { email: 'talent@example.test', display_name: 'Dana', editable: false },
    subject: 'Senior Engineer — Remote',
    body: 'Hi Dana, regarding the Senior Engineer role.',
    context: {
      requisition_reference: 'REQ-42',
      requisition_title: 'Senior Engineer',
      template_id: 'system.requisition-contact.v1',
      template_version: '1',
    },
    ...over,
  };
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
        canSendEmail
        loadStatusFn={vi.fn().mockResolvedValue(status({ bound: false, status: 'reauth_required', needs_reauthorization: true }))}
      />,
    );
    const link = await screen.findByTestId('microsoft-connect-link');
    expect(link).toHaveAttribute('href', '/settings/me');
    expect(screen.queryByTestId('microsoft-authorize-button')).toBeNull();
  });

  it('clicking "Send email" opens the composer and does NOT transmit (INV-1)', async () => {
    const draftFn = vi.fn().mockResolvedValue(draft());
    const sendEmailFn = vi.fn();
    renderR(
      <MicrosoftRecruiterActions
        talentId="t1"
        requisitionId="r1"
        canSendEmail
        loadStatusFn={vi.fn().mockResolvedValue(status({}))}
        draftFn={draftFn}
        sendEmailFn={sendEmailFn}
      />,
    );
    fireEvent.click(await screen.findByTestId('microsoft-send-email'));
    // Composer opened + draft generated; nothing sent yet.
    expect(await screen.findByTestId('email-composer-body')).toBeInTheDocument();
    expect(draftFn).toHaveBeenCalledTimes(1);
    expect(sendEmailFn).not.toHaveBeenCalled();
  });

  it('composing then sending shows an accepted-delivery (NOT responded) confirmation', async () => {
    const draftFn = vi.fn().mockResolvedValue(draft());
    const sendEmailFn = vi.fn().mockResolvedValue({
      interaction_id: 'i1',
      status: 'accepted',
      talent_record_id: 't1',
      requisition_id: 'r1',
      idempotent_replay: false,
    });
    renderR(
      <MicrosoftRecruiterActions
        talentId="t1"
        requisitionId="r1"
        canSendEmail
        loadStatusFn={vi.fn().mockResolvedValue(status({}))}
        draftFn={draftFn}
        sendEmailFn={sendEmailFn}
      />,
    );
    fireEvent.click(await screen.findByTestId('microsoft-send-email'));
    fireEvent.click(await screen.findByTestId('email-composer-send'));

    const sent = await screen.findByTestId('microsoft-email-sent');
    expect(sent.textContent).toMatch(/accepted/i);
    expect(sent.textContent).not.toMatch(/responded|replied/i);
    expect(sendEmailFn).toHaveBeenCalledTimes(1);
    // Recipient is server-owned: the send payload carries no address.
    const payload = sendEmailFn.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('to_email');
    expect(payload).not.toHaveProperty('to');
  });

  it('least-visibility: the Send email affordance is hidden without communication:email:send', async () => {
    renderR(
      <MicrosoftRecruiterActions
        talentId="t1"
        requisitionId="r1"
        canSendEmail={false}
        loadStatusFn={vi.fn().mockResolvedValue(status({}))}
      />,
    );
    // The panel still renders (meeting remains), but no email send button.
    await screen.findByTestId('microsoft-create-meeting');
    expect(screen.queryByTestId('microsoft-send-email')).toBeNull();
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
    renderR(
      <MicrosoftRecruiterActions
        talentId="t1"
        requisitionId="r1"
        canSendEmail
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
