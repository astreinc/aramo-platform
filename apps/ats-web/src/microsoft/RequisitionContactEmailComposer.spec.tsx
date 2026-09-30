import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EmailTemplateView } from '../communications/email-templates-api';

import { RequisitionContactEmailComposer } from './RequisitionContactEmailComposer';
import type { RequisitionContactDraft } from './microsoft-api';

// COMM-C4 PR-2 — the recruiter compose/review/send surface. The human loop is
// ALWAYS generate → review/edit → explicit send. The recipient is server-owned
// (display-only, editable:false) and NEVER submitted by the client (DEC-2/INV-3).
// D-EMAIL-TPL-1 (ET-7) — an optional template picker selects which template the
// SERVER renders; the FE never resolves merge fields.

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
      template_key: 'requisition-contact',
    },
    ...over,
  };
}

// ET-7 — the wired requisition_initial_contact flow. The system default is always
// present; an active tenant override is the sole alternative.
function overrideTemplate(): EmailTemplateView {
  return {
    id: 'row-1',
    template_key: 'requisition-contact',
    category: 'requisition_initial_contact',
    name: 'Acme custom template',
    subject_template: 'Hello {{talent.first_name}}',
    body_template: 'Re {{requisition.title}}',
    is_system_default: false,
    is_active: true,
    updated_at: '2026-09-29T00:00:00.000Z',
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
  // Default: only the system default is available (no override → no picker).
  const listTemplatesFn = vi.fn().mockResolvedValue([]);
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
      listTemplatesFn={listTemplatesFn}
      onSent={onSent}
      {...over}
    />,
  );
  return { draftFn, sendFn, listTemplatesFn, onOpenChange, onSent };
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

  // G2.3 — the prototype "Review email draft" presentation.
  it('G2.3: renders the review-draft header, DRAFT · NOT SENT pill and subtext', async () => {
    renderComposer();
    expect(await screen.findByText('Review email draft')).toBeInTheDocument();
    expect(screen.getByTestId('email-composer-status').textContent).toMatch(
      /DRAFT · NOT SENT/,
    );
    expect(
      screen.getByText(/nothing sends until you click Send/i),
    ).toBeInTheDocument();
  });

  it('G2.3: banner cites REQ + title without enumerating inserted fields', async () => {
    renderComposer();
    const banner = await screen.findByTestId('email-composer-context');
    expect(banner.textContent).toMatch(/Draft prepared from/i);
    expect(banner.textContent).toMatch(/REQ-42 · Senior Engineer/);
    expect(banner.textContent).toMatch(/Review and edit the message before sending/i);
  });

  it('G2.3: From shows an M365 CONNECTED badge; To is a locked chip resolved from the record', async () => {
    renderComposer();
    expect(await screen.findByTestId('email-composer-from')).toHaveTextContent(
      'M365 CONNECTED',
    );
    expect(screen.getByTestId('email-composer-recipient').textContent).toMatch(
      /talent@example\.test/,
    );
    expect(
      screen.getByText(/recipient can.t be changed here/i),
    ).toBeInTheDocument();
  });

  it('G2.3: footer states logging is automatic (a line, not a checkbox) on the REQ', async () => {
    renderComposer();
    await screen.findByTestId('email-composer-body');
    const line = document.querySelector('.rc-eml__logline');
    expect(line?.textContent).toMatch(
      /Sent email is logged to this Talent.s activity on REQ-42 automatically/i,
    );
    // It is a static line — NOT a checkbox control.
    expect(
      document.querySelector('.rc-eml__logline input[type="checkbox"]'),
    ).toBeNull();
    // And there is no "Save draft" affordance (Graph is send-only).
    expect(screen.queryByText(/Save draft/i)).toBeNull();
  });
});

describe('RequisitionContactEmailComposer — template picker (ET-7)', () => {
  it('no tenant override → no picker; default draft loads with NO template_key', async () => {
    const { draftFn, listTemplatesFn } = renderComposer(); // listTemplatesFn → []
    await waitFor(() => expect(draftFn).toHaveBeenCalledTimes(1));
    expect(draftFn.mock.calls[0]![0]).not.toHaveProperty('template_key');
    await screen.findByTestId('email-composer-body');
    await waitFor(() => expect(listTemplatesFn).toHaveBeenCalled());
    expect(screen.queryByTestId('email-composer-template')).toBeNull();
  });

  it('active tenant override → picker offers the Aramo default + the override', async () => {
    const listTemplatesFn = vi.fn().mockResolvedValue([overrideTemplate()]);
    renderComposer({ listTemplatesFn });
    const picker = await screen.findByTestId('email-composer-template');
    expect(picker).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Aramo default' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Acme custom template' })).toBeInTheDocument();
  });

  it('selecting the override re-renders on the SERVER (requisition-contact key); recipient stays locked', async () => {
    const draftFn = vi.fn().mockImplementation((input: { template_key?: string }) =>
      Promise.resolve(
        input.template_key
          ? draft({ subject: 'OVERRIDE SUBJECT', body: 'Rendered override body' })
          : draft(),
      ),
    );
    const listTemplatesFn = vi.fn().mockResolvedValue([overrideTemplate()]);
    renderComposer({ draftFn, listTemplatesFn });

    const picker = await screen.findByTestId('email-composer-template');
    await waitFor(() => expect(draftFn).toHaveBeenCalledTimes(1));
    fireEvent.change(picker, { target: { value: 'override' } });

    await waitFor(() => expect(draftFn).toHaveBeenCalledTimes(2));
    expect(draftFn.mock.calls[1]![0]).toMatchObject({ template_key: 'requisition-contact' });
    await waitFor(() =>
      expect(screen.getByTestId('email-composer-subject')).toHaveValue('OVERRIDE SUBJECT'),
    );
    // subject/body remain editable after the server render
    const body = screen.getByTestId('email-composer-body');
    expect(body).toHaveValue('Rendered override body');
    fireEvent.change(body, { target: { value: 'edited after render' } });
    expect(body).toHaveValue('edited after render');
    // recipient is server-authoritative + display-only throughout
    const recipient = screen.getByTestId('email-composer-recipient');
    expect(recipient.tagName).not.toBe('INPUT');
    expect(recipient.tagName).not.toBe('TEXTAREA');
  });

  it('switching back to the Aramo default re-renders with NO template_key', async () => {
    const draftFn = vi.fn().mockImplementation((input: { template_key?: string }) =>
      Promise.resolve(input.template_key ? draft({ subject: 'OVERRIDE' }) : draft()),
    );
    const listTemplatesFn = vi.fn().mockResolvedValue([overrideTemplate()]);
    renderComposer({ draftFn, listTemplatesFn });
    const picker = await screen.findByTestId('email-composer-template');
    await waitFor(() => expect(draftFn).toHaveBeenCalledTimes(1));
    fireEvent.change(picker, { target: { value: 'override' } });
    // wait for the override render to settle (drafting resolved) before switching back
    await waitFor(() => expect(screen.getByTestId('email-composer-subject')).toHaveValue('OVERRIDE'));
    fireEvent.change(picker, { target: { value: 'default' } });
    await waitFor(() => expect(draftFn).toHaveBeenCalledTimes(3));
    expect(draftFn.mock.calls[2]![0]).not.toHaveProperty('template_key');
  });

  it('the FE never interpolates merge fields — the server body is shown verbatim', async () => {
    const draftFn = vi
      .fn()
      .mockResolvedValue(draft({ body: 'Literal {{talent.first_name}} shown exactly as sent' }));
    renderComposer({ draftFn });
    const body = await screen.findByTestId('email-composer-body');
    expect(body).toHaveValue('Literal {{talent.first_name}} shown exactly as sent');
  });

  it('a selected template that becomes unavailable fails cleanly — draft cleared, Send disabled', async () => {
    const gone = Object.assign(new Error('gone'), { code: 'EMAIL_TEMPLATE_NOT_FOUND', status: 404 });
    const draftFn = vi.fn().mockImplementation((input: { template_key?: string }) =>
      input.template_key ? Promise.reject(gone) : Promise.resolve(draft()),
    );
    const listTemplatesFn = vi.fn().mockResolvedValue([overrideTemplate()]);
    renderComposer({ draftFn, listTemplatesFn });
    const picker = await screen.findByTestId('email-composer-template');
    await waitFor(() => expect(draftFn).toHaveBeenCalledTimes(1));
    fireEvent.change(picker, { target: { value: 'override' } });
    // clean failure + no stale rendered content left sendable
    expect(await screen.findByTestId('email-composer-draft-error')).toBeInTheDocument();
    expect(screen.getByTestId('email-composer-send')).toBeDisabled();
  });

  it('busy guard: the picker is disabled while a re-render is in flight', async () => {
    let resolve2: (v: unknown) => void = () => undefined;
    const draftFn = vi
      .fn()
      .mockResolvedValueOnce(draft())
      .mockReturnValueOnce(new Promise((r) => (resolve2 = r)));
    const listTemplatesFn = vi.fn().mockResolvedValue([overrideTemplate()]);
    renderComposer({ draftFn, listTemplatesFn });
    const picker = await screen.findByTestId('email-composer-template');
    await waitFor(() => expect(draftFn).toHaveBeenCalledTimes(1));
    fireEvent.change(picker, { target: { value: 'override' } });
    await waitFor(() => expect(picker).toBeDisabled());
    resolve2(draft({ subject: 'X' }));
  });
});
