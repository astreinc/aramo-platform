// Field test 2026-11-25 (iOS + Android) — the side-menu screens' "‹ Home" link scrolled away with
// the page, so going back meant scrolling to the top first. It now stays put above the list.
import { render, screen, within } from '@testing-library/react-native';

import { NotificationsScreen } from '../NotificationsScreen';

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
}));
jest.mock('../../../components/Toast', () => ({ useToast: () => ({ show: jest.fn() }) }));
jest.mock('../../../features/inbox/queries', () => ({
  ...jest.requireActual('../../../features/inbox/queries'),
  useOnline: () => true,
  useRecheckOnline: () => jest.fn(),
}));
const mockItem = { id: 'n1', type: 'SIGNED', envelope_subject: 'Lease', actor_name: 'Jo', created_at: new Date().toISOString(), read_at: null };
jest.mock('../../../features/notifications/queries', () => ({
  useFeed: () => ({ data: { pages: [{ items: Array.from({ length: 30 }, (_, i) => ({ ...mockItem, id: `n${i}` })) }] }, isLoading: false, refetch: jest.fn(), hasNextPage: false }),
  useUnreadCount: () => ({ data: 30 }),
  useMarkRead: () => ({ one: jest.fn(async () => undefined), all: jest.fn(async () => undefined) }),
}));

describe('NotificationsScreen', () => {
  it('the "‹ Home" link is above the list, not inside what scrolls', () => {
    render(<NotificationsScreen />);
    expect(screen.getByTestId('back-home')).toBeTruthy();
    expect(within(screen.getByTestId('notifications-list')).queryByTestId('back-home')).toBeNull();
  });
});
