// Home view (M-A4 §2; handoff §2A): banner, welcome, chips, assigned tasks with Sign,
// "All clear for now", 5 activity rows, swipe hint, View all agreements.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { mergeAgreements } from '../../inbox/agreementsModel';
import { received, sent } from '../../inbox/__tests__/fixtures';
import type { BillingAccount, InboxList } from '../../inbox/types';
import { HomeView, type HomeViewProps } from '../HomeBody';
import { homeModel } from '../homeModel';

const NOW = Date.parse('2026-10-20T13:00:00.000Z');

function props(over: Partial<HomeViewProps> = {}): HomeViewProps {
  const task = received({
    subject: 'Offer letter',
    can_sign: true,
    sent_at: '2026-10-20T10:00:00.000Z',
  });
  const rows = mergeAgreements(
    [sent('IN_PROGRESS', { subject: 'MSA' }), sent('DRAFT', { subject: 'Draft NDA' })],
    { waiting: [task], completed: [], other: [] } as unknown as InboxList,
  );
  const billing = {
    tenant_kind: 'PERSONAL',
    subscription: { source: 'FREE' },
    allowance: { limit: 5, used: 1, remaining: 4, daily: { limit: 2, used: 0, remaining: 2 } },
  } as unknown as BillingAccount;
  return {
    model: homeModel({ rows, displayName: 'Priya Raman', billing, now: NOW }),
    online: true,
    showHint: true,
    onDismissHint: jest.fn(),
    onChip: jest.fn(),
    onSign: jest.fn(),
    onRow: jest.fn(),
    onViewAll: jest.fn(),
    now: NOW,
    ...over,
  };
}

describe('HomeView', () => {
  it('renders the plan banner, welcome, chips, tasks and activity', () => {
    render(<HomeView {...props()} />);
    expect(screen.getByText('4 of 5 free sends left this month')).toBeTruthy();
    expect(screen.getByText('Up to 2 a day. Signing is always free.')).toBeTruthy();
    expect(screen.getByText('Welcome, Priya')).toBeTruthy();
    expect(screen.getByText('Assigned tasks (1)')).toBeTruthy();
    expect(screen.getByText('From Northwind Staffing · 3h')).toBeTruthy();
    expect(screen.getByText('Agreement activity')).toBeTruthy();
    expect(screen.getByText('MSA')).toBeTruthy();
    expect(screen.getByText('Draft NDA')).toBeTruthy();
    expect(screen.queryByText(/tomorrow/i)).toBeNull();
  });

  it('chips, Sign, rows and View all call through', () => {
    const p = props();
    render(<HomeView {...p} />);
    fireEvent.press(screen.getByTestId('home-chip-waiting'));
    fireEvent.press(screen.getByTestId('home-chip-drafts'));
    expect(p.onChip).toHaveBeenNthCalledWith(1, 'waiting');
    expect(p.onChip).toHaveBeenNthCalledWith(2, 'drafts');
    const task = p.model.tasks[0];
    fireEvent.press(screen.getByTestId(`home-sign-${task?.inboxItemId}`));
    expect(p.onSign).toHaveBeenCalledWith(task);
    fireEvent.press(screen.getByText('MSA'));
    expect(p.onRow).toHaveBeenCalledWith(expect.objectContaining({ subject: 'MSA' }));
    fireEvent.press(screen.getByTestId('home-view-all'));
    expect(p.onViewAll).toHaveBeenCalled();
  });

  it('Sign is disabled offline with the reason, and the offline banner shows', () => {
    const p = props({ online: false });
    render(<HomeView {...p} />);
    expect(screen.getByText('Offline · showing saved data')).toBeTruthy();
    fireEvent.press(screen.getByTestId(`home-sign-${p.model.tasks[0]?.inboxItemId}`));
    expect(p.onSign).not.toHaveBeenCalled();
  });

  it('shows "All clear for now" with nothing to sign, and no banner for Business', () => {
    const rows = mergeAgreements([sent('COMPLETED')], null);
    render(
      <HomeView {...props({ model: homeModel({ rows, displayName: null, billing: null }) })} />,
    );
    expect(screen.getByText('All clear for now')).toBeTruthy();
    expect(screen.getByText('Assigned tasks (0)')).toBeTruthy();
    expect(screen.getByText('Welcome')).toBeTruthy();
    expect(screen.queryByTestId('home-plan-banner')).toBeNull();
  });

  it('swipe hint: Got it dismisses; hidden once dismissed', () => {
    const p = props();
    const { rerender } = render(<HomeView {...p} />);
    fireEvent.press(screen.getByTestId('home-hint-ok'));
    expect(p.onDismissHint).toHaveBeenCalled();
    rerender(<HomeView {...p} showHint={false} />);
    expect(screen.queryByTestId('home-hint-ok')).toBeNull();
  });
});
