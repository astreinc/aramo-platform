import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RequisitionContactEmailComposer } from './RequisitionContactEmailComposer';
import type { RequisitionContactDraft } from './microsoft-api';

// COMM-C4 PR-2 — the recruiter compose/review/send surface. The human loop is
// ALWAYS generate → review/edit → explicit send. The recipient is server-owned
// (display-only, editable:false) and NEVER submitted by the client (DEC-2/INV-3).

function draft(over: Partial<RequisitionContactDraft> = {}): RequisitionContactDraft {
  return {
    to: { email: 'talent@example.test', display_name: 'Dana Talent', editable: false },
    subject: 'Senior Engineer — Remote (contract)',
    body: 'Hi Dana,\n\nI am reaching out regarding the Senior Engineer opportunity (REQ-42).',
    context: {
      requisition_reference: 'REQ-42',
      requisition_title: 'Senior Engineer',
      template_id: 'system.requisition-contact.v1',
      template_version: '1',
    },
    ...over,
  };
}

function sendResult() {
  return {
    interaction_id: 'i1',
    status: 'accepted' as const,
    talent_record_id: 't1',
    requisition_id: 'r1',
    idempotent_replay: false,
  };
}

function renderComposer(
  over: Partial<React.ComponentProps<typeof RequisitionContactEmailComposer>> = {},
) {
  const draftFn = vi.fn().mockResolvedValue(draft());
  const sendFn = vi.fn().mockResolvedValue(sendResult());
  const onOpenChange = vi.fn();
  const onSent = vi.fn();
  render(
    <RequisitionContactEmailComposer
      open
      onOpenChange={onOpenChange}
      talentId="t1"
      requisitionId="r1"
      pipelineId="p1"
      draftFn={draftFn}
      sendFn={sendFn}
      onSent={onSent}
      {...over}
    />,
  );
  return { draftFn, sendFn, onOpenChange, onSent };
}

describe('RequisitionContactEmailComposer', () => {
  it('on open, generates the draft once and seeds editable subject/body; recipient is display-only (not editable)', async () => {
    const { draftFn } = renderComposer();

    await waitFor(() => expect(draftFn).toHaveBeenCalledTimes(1));
    expect(draftFn).toHaveBeenCalledWith({
      talent_record_id: 't1',
      requisition_id: 'r1',
      pipeline_id: 'p1',
    });

    // Recipient is shown for transparency but is NOT an editable control.
    const recipient = await screen.findByTestId('email-composer-recipient');
    expect(recipient.textContent).toMatch(/talent@example\.test/);
    expect(recipient.tagName).not.toBe('INPUT');
    expect(recipient.tagName).not.toBe('TEXTAREA');

    // Editable subject + body pre-filled from the draft.
    expect((await screen.findByTestId('email-composer-subject')) as HTMLInputElement).toHaveValue(
      'Senior Engineer — Remote (contract)',
    );
    expect(screen.getByTestId('email-composer-body')).toHaveValue(
      'Hi Dana,\n\nI am reaching out regarding the Senior Engineer opportunity (REQ-42).',
    );
  });

  it('sends the EDITED subject/body and carries NO recipient field (DEC-2/INV-3)', async () => {
    const { sendFn, onSent } = renderComposer();

    const body = await screen.findByTestId('email-composer-body');
    fireEvent.change(body, { target: { value: 'A recruiter-edited body.' } });
    fireEvent.click(screen.getByTestId('email-composer-send'));

    await waitFor(() => expect(sendFn).toHaveBeenCalledTimes(1));
    const payload = sendFn.mock.calls[0][0] as Record<string, unknown>;
    expect(payload['body']).toBe('A recruiter-edited body.');
    expect(payload['subject']).toBe('Senior Engineer — Remote (contract)');
    expect(payload['talent_record_id']).toBe('t1');
    expect(payload['requisition_id']).toBe('r1');
    expect(payload['pipeline_id']).toBe('p1');
    expect(typeof payload['idempotency_key']).toBe('string');
    // The client NEVER submits a recipient — no address key of any name.
    expect(payload).not.toHaveProperty('to');
    expect(payload).not.toHaveProperty('to_email');
    expect(payload).not.toHaveProperty('to_address');
    expect(payload).not.toHaveProperty('email');
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('busy/double-submit guard: Send disabled in-flight; a double click transmits once', async () => {
    let resolveSend: (v: unknown) => void = () => undefined;
    const sendFn = vi.fn().mockReturnValue(new Promise((r) => (resolveSend = r)));
    renderComposer({ sendFn });

    const send = await screen.findByTestId('email-composer-send');
    fireEvent.click(send);
    fireEvent.click(send); // second click while in-flight
    expect(send).toBeDisabled();
    expect(sendFn).toHaveBeenCalledTimes(1);
    resolveSend(sendResult());
    await waitFor(() => expect(sendFn).toHaveBeenCalledTimes(1));
  });

  it('surfaces draft warnings non-blocking (send still possible)', async () => {
    const draftFn = vi.fn().mockResolvedValue(
      draft({ warnings: ['role summary omitted — no authoritative source'] }),
    );
    renderComposer({ draftFn });
    const warn = await screen.findByTestId('email-composer-warning');
    expect(warn.textContent).toMatch(/role summary omitted/i);
    expect(await screen.findByTestId('email-composer-send')).not.toBeDisabled();
  });

  it('cancel requests close without sending', async () => {
    const { sendFn, onOpenChange } = renderComposer();
    fireEvent.click(await screen.findByTestId('email-composer-cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(sendFn).not.toHaveBeenCalled();
  });
});
