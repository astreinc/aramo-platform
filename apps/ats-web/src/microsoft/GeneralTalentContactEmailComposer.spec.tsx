import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GeneralTalentContactEmailComposer } from './GeneralTalentContactEmailComposer';
import type { GeneralTalentContactDraft } from './microsoft-api';

// COMM-RECRUITER-W1 (W1-A3) — Talent-only compose/review/send. The human loop is
// generate → review/edit → explicit send. Recipient server-owned (editable:false,
// never submitted). No template selector. The send carries NO requisition_id.

function draft(over: Partial<GeneralTalentContactDraft> = {}): GeneralTalentContactDraft {
  return {
    to: { email: 'talent@example.test', display_name: 'Dana Talent', editable: false },
    subject: 'Astre Consulting | Opportunities in your field',
    body: "Hi Dana,\n\nI'm reaching out from Astre Consulting.",
    context: {
      template_id: 'system.talent-general-contact.v1',
      template_version: '1',
      template_key: 'talent-general-contact',
    },
    ...over,
  };
}

function sendResult() {
  return {
    interaction_id: 'i1',
    status: 'accepted' as const,
    talent_record_id: 't1',
    requisition_id: null,
    idempotent_replay: false,
  };
}

function renderComposer(
  over: Partial<React.ComponentProps<typeof GeneralTalentContactEmailComposer>> = {},
) {
  const draftFn = vi.fn().mockResolvedValue(draft());
  const sendFn = vi.fn().mockResolvedValue(sendResult());
  const onOpenChange = vi.fn();
  const onSent = vi.fn();
  render(
    <GeneralTalentContactEmailComposer
      open
      onOpenChange={onOpenChange}
      talentId="t1"
      draftFn={draftFn}
      sendFn={sendFn}
      onSent={onSent}
      {...over}
    />,
  );
  return { draftFn, sendFn, onOpenChange, onSent };
}

describe('GeneralTalentContactEmailComposer (W1-A3)', () => {
  it('requests the Talent-only draft with NO requisition and shows a locked, server-owned recipient', async () => {
    const { draftFn } = renderComposer();
    await screen.findByTestId('gtc-email-composer-recipient');
    expect(draftFn).toHaveBeenCalledWith({ talent_record_id: 't1' });
    expect(draftFn.mock.calls[0]![0]).not.toHaveProperty('requisition_id');
    // No template selector exists on this surface.
    expect(screen.queryByTestId('gtc-email-composer-template')).toBeNull();
    expect(screen.getByTestId('gtc-email-composer-recipient').textContent).toContain('talent@example.test');
  });

  it('sends the reviewed subject/body with NO requisition_id (Talent-only send)', async () => {
    const { sendFn, onSent } = renderComposer();
    await screen.findByTestId('gtc-email-composer-body');
    fireEvent.click(screen.getByTestId('gtc-email-composer-send'));
    await waitFor(() => expect(sendFn).toHaveBeenCalledTimes(1));
    const payload = sendFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('requisition_id');
    expect(payload['talent_record_id']).toBe('t1');
    expect(payload['template_key']).toBe('talent-general-contact');
    expect(payload['template_id']).toBe('system.talent-general-contact.v1');
    expect(onSent).toHaveBeenCalledTimes(1);
  });
});
