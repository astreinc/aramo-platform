// Client Rule Consolidation C3 — runs under vitest and mobile Jest (globals only).
// Audit rows 1–13: clients render the server's `actions`; a missing decision is "not allowed".
import { INBOX_ACTION_KEYS, NO_INBOX_ACTIONS, NO_SENDER_ACTIONS, SENDER_ACTION_KEYS, inboxActionsOf, senderActionsOf } from '../index.js';

describe('server-sent actions (C1 keys, read defensively)', () => {
  it('the sender keys match the C1 contract', () => {
    expect([...SENDER_ACTION_KEYS]).toEqual(['edit', 'send', 'delete_draft', 'void', 'remind', 'delete', 'restore', 'download', 'certificate', 'sign', 'host_in_person', 'purge', 'dequeue_purge']);
  });
  it('the inbox keys match the C1 contract', () => {
    expect([...INBOX_ACTION_KEYS]).toEqual(['sign', 'download', 'delete', 'restore', 'report']);
  });

  it.each([
    ['no row', undefined],
    ['null row', null],
    ['row without actions', {}],
    ['actions null', { actions: null }],
    ['actions not an object', { actions: 'edit' }],
  ])('%s: every sender action is false', (_n, row) => {
    expect(senderActionsOf(row as never)).toEqual(NO_SENDER_ACTIONS);
    expect(inboxActionsOf(row as never)).toEqual(NO_INBOX_ACTIONS);
  });

  it.each([
    [{ void: true }, 'void', true],
    [{ void: 'true' }, 'void', false],
    [{ void: 1 }, 'void', false],
    [{ edit: true, send: false }, 'send', false],
    [{ edit: true }, 'edit', true],
    [{ remind: true }, 'delete', false],
  ] as const)('sender %j → %s = %s', (actions, key, expected) => {
    expect(senderActionsOf({ actions })[key]).toBe(expected);
  });

  it.each([
    [{ sign: true }, 'sign', true],
    [{ download: true }, 'download', true],
    [{ report: 'yes' }, 'report', false],
    [{ restore: true }, 'delete', false],
  ] as const)('inbox %j → %s = %s', (actions, key, expected) => {
    expect(inboxActionsOf({ actions })[key]).toBe(expected);
  });

  it('unknown keys are dropped', () => {
    expect(Object.keys(senderActionsOf({ actions: { bogus: true } }))).toEqual([...SENDER_ACTION_KEYS]);
  });
});
