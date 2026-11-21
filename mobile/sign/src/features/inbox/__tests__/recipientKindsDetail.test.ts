// Sender envelope detail with M-A5 recipient kinds: copy recipients apart (never counted
// as signers), and which in-person signers can be hosted now.
import {
  copiesOf,
  copyTimingLine,
  hostableSigners,
  orderedRecipients,
  progressOf,
} from '../envelopeActions';
import type { DetailRecipient, SenderEnvelopeDetail } from '../types';
import { detail } from './fixtures';

const base = detail().recipients[0]!;
const rec = (id: string, over: Partial<DetailRecipient>): DetailRecipient => ({
  ...base,
  id,
  name: id.toUpperCase(),
  email: `${id}@example.com`,
  can_remind: false,
  ...over,
});

function env(over: Partial<SenderEnvelopeDetail> = {}): SenderEnvelopeDetail {
  return detail({
    recipients: [
      rec('a', { signing_order: 0, status: 'SIGNED' }),
      rec('walk', { signing_order: 1, recipient_kind: 'IN_PERSON_SIGNER', email: null }),
      rec('cc', { signing_order: 2, recipient_kind: 'RECEIVES_COPY', copy_delivery: 'BOTH' }),
    ],
    ...over,
  });
}

describe('copy recipients in the sender detail (M-A5 §2)', () => {
  it('are listed apart and never counted as signers', () => {
    const d = env();
    expect(orderedRecipients(d).map((r) => r.id)).toEqual(['a', 'walk']);
    expect(orderedRecipients({ ...d, routing_mode: 'SEQUENTIAL' }).map((r) => r.id)).toEqual([
      'a',
      'walk',
    ]);
    expect(copiesOf(d).map((r) => r.id)).toEqual(['cc']);
    expect(progressOf(d)).toMatchObject({ signed: 1, total: 2 });
  });

  it('show their timing', () => {
    expect(
      copyTimingLine(rec('x', { recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_SEND' })),
    ).toBe('Receives a copy when sent');
    expect(
      copyTimingLine(rec('x', { recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_COMPLETION' })),
    ).toBe('Receives a copy after completion');
    expect(
      copyTimingLine(rec('x', { recipient_kind: 'RECEIVES_COPY', copy_delivery: 'BOTH' })),
    ).toBe('Receives a copy when sent and after completion');
  });
});

// C3 (audit row 13) — who can be hosted is the server's per-recipient `hostable`
// (actions.host_in_person and the hosted-session rule); the app derives nothing.
describe('Start in-person signing availability (M-A5 §3.1)', () => {
  const hostEnv = (hostable: Record<string, boolean>) =>
    env({ recipients: env().recipients.map((r) => ({ ...r, ...(r.id in hostable ? { hostable: hostable[r.id] } : {}) })) });

  it('exactly the recipients the server marks hostable, while the build ships hosting', () => {
    expect(hostableSigners(hostEnv({ walk: true }), true).map((r) => r.id)).toEqual(['walk']);
    expect(hostableSigners(hostEnv({ walk: true, a: true }), true).map((r) => r.id)).toEqual(['a', 'walk']);
  });

  it('nothing without the build flag, or when the server marks no one (or sends no flag)', () => {
    expect(hostableSigners(hostEnv({ walk: true }), false)).toEqual([]);
    expect(hostableSigners(hostEnv({ walk: false }), true)).toEqual([]);
    expect(hostableSigners(env(), true)).toEqual([]);
  });

  it('an in-person signer of an open envelope is not hostable unless the server says so', () => {
    expect(hostableSigners(env({ routing_mode: 'SEQUENTIAL', next_signer_id: 'walk' }), true)).toEqual([]);
  });
});
