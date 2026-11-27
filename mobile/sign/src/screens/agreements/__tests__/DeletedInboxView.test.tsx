// M-A17 (UAT SIG-15 retest, web ≡ app) — the Deleted list with Restore.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { received, sent } from '../../../features/inbox/__tests__/fixtures';
import { DeletedInboxView } from '../DeletedInboxScreen';

jest.setTimeout(30_000);

describe('DeletedInboxView', () => {
  const item = { ...received({ subject: 'Offer letter', from: 'Northwind Staffing' }), id: 'item-1' };

  it('lists deleted envelopes and restores the one tapped', () => {
    const onRestore = jest.fn();
    render(<DeletedInboxView items={[item]} loading={false} failed={false} online busyId={null} onRestore={onRestore} />);
    expect(screen.getByText('Offer letter')).toBeTruthy();
    expect(screen.getByText('Northwind Staffing')).toBeTruthy();
    fireEvent.press(screen.getByTestId('deleted-restore-item-1'));
    expect(onRestore).toHaveBeenCalledWith(item);
  });

  it('says when nothing is deleted', () => {
    render(<DeletedInboxView items={[]} loading={false} failed={false} online busyId={null} onRestore={jest.fn()} />);
    expect(screen.getByText('Nothing deleted.')).toBeTruthy();
  });

  it('cannot restore offline', () => {
    const onRestore = jest.fn();
    render(<DeletedInboxView items={[item]} loading={false} failed={false} online={false} busyId={null} onRestore={onRestore} />);
    fireEvent.press(screen.getByTestId('deleted-restore-item-1'));
    expect(onRestore).not.toHaveBeenCalled();
  });

  // APP-DELETED-1 (UAT DEL-09) — the sender's own deleted envelopes, with Restore when the server allows.
  describe('Sent by me', () => {
    const done = sent('COMPLETED', { subject: 'NDA' });
    const restorable = { ...done, id: 'env-1', actions: { ...done.actions!, restore: true } };
    const purged = { ...done, id: 'env-2', subject: 'Old offer', actions: { ...done.actions!, restore: false } };
    const base = { items: [item], loading: false, failed: false, online: true, busyId: null, onRestore: jest.fn() } as const;

    it('lists them and restores only where actions.restore', () => {
      const onRestoreSent = jest.fn();
      render(<DeletedInboxView {...base} sent={{ items: [restorable, purged], loading: false, failed: false, onRestore: onRestoreSent }} />);
      expect(screen.getByText('Sent by me')).toBeTruthy();
      expect(screen.getByText('Received')).toBeTruthy();
      expect(screen.getByText('NDA')).toBeTruthy();
      expect(screen.getByText('Old offer')).toBeTruthy();
      expect(screen.queryByTestId('deleted-sent-restore-env-2')).toBeNull();
      fireEvent.press(screen.getByTestId('deleted-sent-restore-env-1'));
      expect(onRestoreSent).toHaveBeenCalledWith(restorable);
      // The received group still works beside it.
      expect(screen.getByTestId('deleted-restore-item-1')).toBeTruthy();
    });

    it('says when nothing sent is deleted', () => {
      render(<DeletedInboxView {...base} sent={{ items: [], loading: false, failed: false, onRestore: jest.fn() }} />);
      expect(screen.getByTestId('deleted-sent-empty')).toBeTruthy();
    });

    it('is hidden for a user who may not read sent envelopes (null)', () => {
      render(<DeletedInboxView {...base} sent={{ items: null, loading: false, failed: false, onRestore: jest.fn() }} />);
      expect(screen.queryByText('Sent by me')).toBeNull();
      expect(screen.getByText('Offer letter')).toBeTruthy();
    });

    it('cannot restore offline', () => {
      const onRestoreSent = jest.fn();
      render(<DeletedInboxView {...base} online={false} sent={{ items: [restorable], loading: false, failed: false, onRestore: onRestoreSent }} />);
      fireEvent.press(screen.getByTestId('deleted-sent-restore-env-1'));
      expect(onRestoreSent).not.toHaveBeenCalled();
    });
  });
});
