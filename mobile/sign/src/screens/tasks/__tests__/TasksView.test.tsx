// M-A12 W1-D.1 — the Tasks screen view: sections, filter, sort, open.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { mergeAgreements } from '../../../features/inbox/agreementsModel';
import { received } from '../../../features/inbox/__tests__/fixtures';
import type { InboxList } from '../../../features/inbox/types';
import { tasksModel } from '../../../features/tasks/tasksModel';
import { TasksView } from '../TasksScreen';

const inbox: InboxList = {
  waiting: [
    received({ id: 'n1', can_sign: true, subject: 'Offer', from: 'Northwind' }),
    received({ id: 'u1', can_sign: false, my_status: 'upcoming', subject: 'Later', from: 'Acme' }),
  ],
  completed: [],
  other: [],
};

describe('TasksView', () => {
  it('lists Needs me and Upcoming; opens a task; changes filter and sort', () => {
    const rows = mergeAgreements(null, inbox);
    const onOpen = jest.fn();
    const onFilter = jest.fn();
    const onSort = jest.fn();
    render(
      <TasksView model={tasksModel(rows, 'all', 'newest')} filter="all" sort="newest" online onFilter={onFilter} onSort={onSort} onOpen={onOpen} />,
    );
    expect(screen.getByRole('header', { name: 'Needs me' })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Upcoming' })).toBeTruthy();
    expect(screen.getByTestId('tasks-summary').props.children).toBe('1 agreement is waiting for your signature');
    fireEvent.press(screen.getByTestId('task-n1'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ inboxItemId: 'n1', kind: 'needs_me' }));
    fireEvent.press(screen.getByTestId('tasks-sort'));
    expect(onSort).toHaveBeenCalledWith('oldest');
    fireEvent.press(screen.getByTestId('tasks-filter-upcoming'));
    expect(onFilter).toHaveBeenCalledWith('upcoming');
  });

  it('empty state', () => {
    render(
      <TasksView model={tasksModel([], 'all', 'newest')} filter="all" sort="newest" online onFilter={jest.fn()} onSort={jest.fn()} onOpen={jest.fn()} />,
    );
    expect(screen.getByText('You’re all caught up')).toBeTruthy();
  });
});
