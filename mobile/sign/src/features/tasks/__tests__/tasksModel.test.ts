// M-A12 W1-D.1 — Tasks: Needs me (inbox can_sign only) and Upcoming (W2), filter + sort.
import { mergeAgreements } from '../../inbox/agreementsModel';
import { received, sent } from '../../inbox/__tests__/fixtures';
import type { InboxList } from '../../inbox/types';
import { sortTasks, tasksModel } from '../tasksModel';

const inbox = (waiting: InboxList['waiting']): InboxList => ({ waiting, completed: [], other: [] });

const rows = () =>
  mergeAgreements(
    [sent('IN_PROGRESS')],
    inbox([
      received({ can_sign: true, subject: 'Offer', from: 'Northwind', sent_at: '2026-10-02T10:00:00.000Z' }),
      received({ can_sign: true, subject: 'NDA', from: 'Acme', sent_at: '2026-10-05T10:00:00.000Z', envelope_expires_at: '2026-11-01T00:00:00.000Z' }),
      received({ can_sign: false, my_status: 'upcoming', subject: 'Later', from: 'Zeta', sent_at: '2026-10-03T10:00:00.000Z' }),
      received({ can_sign: false, my_status: 'SIGNED', subject: 'Done' }),
    ]),
  );

describe('tasksModel', () => {
  it('Needs me and Upcoming, newest first; never a sent envelope', () => {
    const m = tasksModel(rows(), 'all', 'newest', Date.parse('2026-10-06T10:00:00.000Z'));
    expect(m.needs.map((c) => c.subject)).toEqual(['NDA', 'Offer']);
    expect(m.upcoming.map((c) => c.subject)).toEqual(['Later']);
    expect(m.summary).toBe('2 agreements are waiting for your signature');
    expect(m.needs[0]?.due).toBe('Link expires Nov 1, 2026');
  });

  it('filters and sorts', () => {
    expect(tasksModel(rows(), 'needs_me', 'oldest').upcoming).toEqual([]);
    expect(tasksModel(rows(), 'needs_me', 'oldest').needs.map((c) => c.subject)).toEqual(['Offer', 'NDA']);
    expect(tasksModel(rows(), 'upcoming', 'newest').needs).toEqual([]);
    const m = tasksModel(rows(), 'all', 'sender');
    expect(sortTasks(m.needs, 'sender').map((c) => c.from)).toEqual(['Acme', 'Northwind']);
  });

  it('empty when nothing is assigned', () => {
    const m = tasksModel(mergeAgreements([], inbox([])), 'all', 'newest');
    expect(m.empty).toBe(true);
    expect(m.summary).toBe('Nothing needs your signature right now.');
  });
});
