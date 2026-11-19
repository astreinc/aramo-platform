// M-A17 (UAT SIG-15 retest, web ≡ app) — the Deleted list with Restore.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { received } from '../../../features/inbox/__tests__/fixtures';
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
});
