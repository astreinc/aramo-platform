// M-A14 §1 item 8 (a17) — "Want to sign another document?" only when GET /v1/sign/inbox has
// an item the user can sign now.
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { received } from '../../../../features/inbox/__tests__/fixtures';
import type { InboxList } from '../../../../features/inbox/types';
import { SignNextModal } from '../SignNextModal';
import { sentLabel } from '../signNext';
import { pathOf, renderWith, settle } from './helpers';

function renderModal(inbox: InboxList, visible = true) {
  const onClose = jest.fn();
  const onSignNext = jest.fn();
  const r = renderWith(
    <SignNextModal visible={visible} onClose={onClose} onSignNext={onSignNext} />,
    (req) => (pathOf(req.url) === '/v1/sign/inbox' ? { status: 200, body: inbox } : { status: 404, body: {} }),
  );
  return { ...r, onClose, onSignNext };
}

const SENT = '2026-11-02T14:02:00.000Z';

describe('SignNextModal', () => {
  it('renders nothing when no inbox item can be signed', async () => {
    const { net } = renderModal({
      waiting: [received({ can_sign: false, my_status: 'upcoming' })],
      completed: [received({ envelope_status: 'COMPLETED', can_sign: false, can_download: true })],
      other: [],
    });
    await waitFor(() => expect(net.calls.some((c) => pathOf(c.url) === '/v1/sign/inbox')).toBe(true));
    await settle(20);
    expect(screen.queryByTestId('sign-next-modal')).toBeNull();
    expect(screen.queryByText('Want to sign another document?')).toBeNull();
  });

  it('renders nothing for an empty inbox', async () => {
    const { net } = renderModal({ waiting: [], completed: [], other: [] });
    await waitFor(() => expect(net.calls.length).toBeGreaterThan(0));
    await settle(20);
    expect(screen.queryByTestId('sign-next-modal')).toBeNull();
  });

  it('renders nothing when not visible', async () => {
    renderModal({ waiting: [received({ subject: 'Services Agreement' })], completed: [], other: [] }, false);
    await settle(50);
    expect(screen.queryByTestId('sign-next-modal')).toBeNull();
  });

  it('shows the first signable item with From and Sent; Sign Next / No thanks', async () => {
    const first = received({ subject: 'Services Agreement', from: 'Example Co', sent_at: SENT });
    const { onSignNext, onClose } = renderModal({
      waiting: [received({ can_sign: false, my_status: 'upcoming', subject: 'Later one' }), first],
      completed: [],
      other: [],
    });
    await waitFor(() => expect(screen.getByTestId('sign-next-modal')).toBeTruthy());
    expect(screen.getByText('Want to sign another document?')).toBeTruthy();
    expect(screen.getByText('Services Agreement')).toBeTruthy();
    expect(screen.getByText('From: Example Co')).toBeTruthy();
    expect(screen.getByText(`Sent: ${sentLabel(SENT)}`)).toBeTruthy();
    expect(screen.queryByText('Later one')).toBeNull();
    fireEvent.press(screen.getByText('Sign Next'));
    expect(onSignNext).toHaveBeenCalledWith(first);
    fireEvent.press(screen.getByText('No thanks'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('formats Sent as "{date} at {time}" (en-US like a17)', () => {
    const local = new Date(2026, 10, 2, 9, 2);
    expect(sentLabel(local.toISOString(), 'en-US')).toBe('Nov 2, 2026 at 9:02 AM');
    expect(sentLabel(null)).toBeNull();
    expect(sentLabel('not a date')).toBeNull();
  });
});
