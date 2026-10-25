// Push tap routing + feed model (directive §8; M-A2 §4; M-A3 §1).
import {
  sections,
  targetFor,
  titleFor,
  withAllRead,
  withRead,
  type FeedItem,
} from '../notificationModel';
import { routeForPushData } from '../pushRouting';

const ENV = 'e5000000-0000-4000-8000-0000000000a1';
const ITEM = 'b1000000-0000-4000-8000-0000000000b2';

describe('routeForPushData', () => {
  it('a sender push opens the envelope detail on its Activity tab', () => {
    expect(routeForPushData({ type: 'SIGNED', envelope_id: ENV })).toEqual({
      name: 'EnvelopeDetail',
      params: { envelopeId: ENV, initialTab: 'activity' },
    });
  });

  it('a recipient push opens the received inbox item (no sender envelope id)', () => {
    expect(routeForPushData({ type: 'SIGNATURE_NEEDED', inbox_item_id: ITEM })).toEqual({
      name: 'ReceivedEnvelope',
      params: { inboxItemId: ITEM },
    });
  });

  it('ignores malformed payloads', () => {
    expect(routeForPushData(null)).toBeNull();
    expect(routeForPushData('SIGNED')).toBeNull();
    expect(routeForPushData([])).toBeNull();
    expect(routeForPushData({ envelope_id: ENV })).toBeNull(); // no type
    expect(routeForPushData({ type: 'HACKED', envelope_id: ENV })).toBeNull();
    expect(routeForPushData({ type: 'SIGNED', envelope_id: 'not-a-uuid' })).toBeNull();
    expect(routeForPushData({ type: 'SIGNED', envelope_id: ENV, inbox_item_id: ITEM })).toBeNull(); // both
    expect(routeForPushData({ type: 'SIGNED' })).toBeNull(); // neither
  });

  it('never routes from a link or token in the payload', () => {
    expect(
      routeForPushData({
        type: 'SIGNATURE_NEEDED',
        url: 'https://sign.aramo.ai/s/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ',
        token: 'x',
      }),
    ).toBeNull();
    const r = routeForPushData({
      type: 'REMINDER',
      inbox_item_id: ITEM,
      url: 'https://evil.example/s/x',
    });
    expect(r).toEqual({ name: 'ReceivedEnvelope', params: { inboxItemId: ITEM } });
  });
});

describe('feed model', () => {
  const item = (over: Partial<FeedItem>): FeedItem => ({
    id: 'n1',
    type: 'SIGNED',
    envelope_id: ENV,
    inbox_item_id: null,
    envelope_subject: 'MSA',
    actor_name: 'Alex Morgan',
    created_at: '2026-10-20T10:00:00.000Z',
    read_at: null,
    ...over,
  });

  it('titles per type', () => {
    expect(titleFor(item({}))).toBe('Alex Morgan signed');
    expect(titleFor(item({ type: 'VIEWED' }))).toBe('Alex Morgan viewed');
    expect(titleFor(item({ type: 'SIGNATURE_NEEDED' }))).toBe('Waiting for your signature');
    expect(titleFor(item({ type: 'EXPIRED' }))).toBe('Link expired');
    expect(titleFor(item({ type: 'COMPLETED' }))).toBe('Everyone signed');
  });

  it('recipient items use inbox_item_id', () => {
    expect(targetFor(item({ envelope_id: null, inbox_item_id: ITEM }))).toEqual({
      name: 'ReceivedEnvelope',
      params: { inboxItemId: ITEM },
    });
  });

  it('groups Today / Earlier', () => {
    const now = new Date('2026-10-20T18:00:00.000Z');
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9).toISOString();
    const s = sections(
      [
        item({ id: 'a', created_at: today }),
        item({ id: 'b', created_at: '2026-10-01T10:00:00.000Z' }),
      ],
      now,
    );
    expect(s.map((x) => [x.title, x.data.map((i) => i.id)])).toEqual([
      ['Today', ['a']],
      ['Earlier', ['b']],
    ]);
  });

  it('mark read / mark all read mirror the server in cached pages', () => {
    const pages = [{ items: [item({ id: 'a' }), item({ id: 'b' })], next_cursor: null }];
    expect(withRead(pages, 'a', 'T')[0]!.items.map((i) => i.read_at)).toEqual(['T', null]);
    expect(withAllRead(pages, 'T')[0]!.items.every((i) => i.read_at === 'T')).toBe(true);
  });
});
