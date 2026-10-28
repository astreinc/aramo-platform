// Recipient-view privacy (directive §6, §7 C-6; §4.6): only what the inbox item returns
// is shown — never other recipients, sender administration or an activity log.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { received } from '../../../features/inbox/__tests__/fixtures';
import type { InboxItem } from '../../../features/inbox/types';
import { ReceivedEnvelopeView } from '../ReceivedEnvelopeScreen';

describe('ReceivedEnvelopeView', () => {
  it('shows subject, sender organization, own status and dates only', () => {
    // Even if a response ever carried more, the view never reads it.
    const leaky = {
      ...received({ subject: 'Offer letter', from: 'Northwind Staffing' }),
      recipients: [{ name: 'Other Person', email: 'other@example.com', status: 'SIGNED' }],
      events: [{ event_type: 'SIGNER_SIGNED', actor: 'Other Person' }],
      sender: { name: 'Internal Admin' },
    } as unknown as InboxItem;
    render(
      <ReceivedEnvelopeView
        item={leaky}
        online
        onSign={jest.fn()}
        onSignedCopy={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    expect(screen.getByText('Offer letter')).toBeTruthy();
    expect(screen.getByText('Northwind Staffing')).toBeTruthy();
    expect(screen.getByText('Waiting for your signature')).toBeTruthy();
    expect(screen.getByText('Valid for 7 days')).toBeTruthy();
    expect(screen.queryByText(/Other Person/)).toBeNull();
    expect(screen.queryByText(/other@example.com/)).toBeNull();
    expect(screen.queryByText(/Internal Admin/)).toBeNull();
    expect(screen.queryByText(/Recipients|Activity/)).toBeNull();
  });

  it('Review and sign only when the server says it can be signed; disabled offline', () => {
    const onSign = jest.fn();
    const { rerender } = render(
      <ReceivedEnvelopeView
        item={received({ can_sign: true })}
        online={false}
        onSign={onSign}
        onSignedCopy={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByTestId('received-sign'));
    expect(onSign).not.toHaveBeenCalled();
    expect(screen.getByText('You’re offline. Connect to do this.')).toBeTruthy();
    rerender(
      <ReceivedEnvelopeView
        item={received({
          can_sign: false,
          can_download: true,
          envelope_status: 'COMPLETED',
          my_status: 'SIGNED',
          completed_at: '2026-10-10T00:00:00Z',
        })}
        online
        onSign={onSign}
        onSignedCopy={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('received-sign')).toBeNull();
    expect(screen.getByTestId('received-copy')).toBeTruthy();
  });
});

// Amendment M-A7 §5.2 (R-11) — the received-envelope view offers a Report action.
describe('ReceivedEnvelopeView — Report (M-A7 §5.2)', () => {
  it('shows "Report this envelope" when wired; disabled offline', () => {
    const onReport = jest.fn();
    const { rerender } = render(
      <ReceivedEnvelopeView item={received({})} online onSign={jest.fn()} onSignedCopy={jest.fn()} onRemove={jest.fn()} onReport={onReport} />,
    );
    fireEvent.press(screen.getByTestId('received-report'));
    expect(onReport).toHaveBeenCalledTimes(1);
    rerender(
      <ReceivedEnvelopeView item={received({})} online={false} onSign={jest.fn()} onSignedCopy={jest.fn()} onRemove={jest.fn()} onReport={onReport} />,
    );
    fireEvent.press(screen.getByTestId('received-report'));
    expect(onReport).toHaveBeenCalledTimes(1);
  });
});
