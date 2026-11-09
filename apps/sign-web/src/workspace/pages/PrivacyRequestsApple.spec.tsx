import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PrivacyRequestView } from '../api';

import { PrivacyRequestsSection } from './PrivacyRequests';

// Apple Go-Live R-8 (web) — deleting an Apple-linked Personal account first goes to
// the Apple revoke round trip; on return (?apple_revoked=1|0) the deletion is offered
// again with the confirmation kept. Best effort: 0 never blocks the deletion.

vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));

const REQ = {
  reference: 'PR-1',
  request_type: 'DELETION',
  status_label: 'Received',
  due_at: null,
  completed_at: null,
  outcome_text: null,
  organization_decides: null,
  retained: [],
} as unknown as PrivacyRequestView;

function renderSection(appleLinked: boolean) {
  const requester = vi.fn().mockResolvedValue(REQ);
  const onAppleRevoke = vi.fn();
  const linked = vi.fn().mockResolvedValue(appleLinked);
  render(
    <PrivacyRequestsSection
      personal
      loader={vi.fn().mockResolvedValue({ items: [] })}
      requester={requester}
      appleLinked={linked}
      onAppleRevoke={onAppleRevoke}
    />,
  );
  return { requester, onAppleRevoke, linked };
}

function confirmDelete() {
  fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
}

describe('Delete my account — Apple revoke (R-8)', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('an Apple-linked account goes to the revoke start first, returning to this page', async () => {
    window.history.replaceState(null, '', '/personal/settings/personal');
    const { requester, onAppleRevoke } = renderSection(true);
    confirmDelete();
    await waitFor(() => expect(onAppleRevoke).toHaveBeenCalledWith('/v1/sign/me/apple/revoke/start?return=%2Fpersonal%2Fsettings%2Fpersonal'));
    expect(requester).not.toHaveBeenCalled();
  });

  it('without Apple the deletion is sent directly', async () => {
    const { requester, onAppleRevoke } = renderSection(false);
    confirmDelete();
    await waitFor(() => expect(requester).toHaveBeenCalledWith('DELETION'));
    expect(onAppleRevoke).not.toHaveBeenCalled();
  });

  it.each([
    ['1', 'Aramo’s access to your Apple ID was removed.'],
    ['0', 'We couldn’t reach Apple'],
  ])('back with apple_revoked=%s: the note shows, the confirmation is kept, and the deletion goes ahead', async (v, text) => {
    window.history.replaceState(null, '', `/personal/settings/personal?apple_revoked=${v}`);
    const { requester, onAppleRevoke, linked } = renderSection(true);
    expect(screen.getByTestId('privacy-apple-revoked')).toHaveTextContent(text);
    expect(window.location.search).toBe('');
    expect(screen.getByLabelText('Type DELETE to confirm')).toHaveValue('DELETE');
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    await waitFor(() => expect(requester).toHaveBeenCalledWith('DELETION'));
    expect(onAppleRevoke).not.toHaveBeenCalled();
    expect(linked).not.toHaveBeenCalled();
  });
});
