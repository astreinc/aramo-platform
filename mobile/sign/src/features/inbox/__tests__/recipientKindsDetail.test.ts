// Sender envelope detail with M-A5 recipient kinds: copy recipients apart (never counted
// as signers), and which in-person signers can be hosted now.
import {
  copiesOf,
  copyTimingLine,
  hostableSigners,
  orderedRecipients,
  progressOf,
} from '../envelopeActions';
import type { DetailRecipient, SenderContext, SenderEnvelopeDetail } from '../types';
import { CTX_OWNER, detail } from './fixtures';

const base = detail().recipients[0]!;
const rec = (id: string, over: Partial<DetailRecipient>): DetailRecipient => ({
  ...base,
  id,
  name: id.toUpperCase(),
  email: `${id}@example.com`,
  can_remind: false,
  ...over,
});

const ctxWith = (inPerson: boolean | undefined) =>
  ({
    ...CTX_OWNER,
    features: inPerson === undefined ? {} : { in_person_signing: inPerson },
  }) as unknown as SenderContext;

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

describe('Start in-person signing availability (M-A5 §3.1)', () => {
  it('an unsigned in-person signer of an open envelope, with the capability and the flag', () => {
    expect(hostableSigners(env(), ctxWith(true), true).map((r) => r.id)).toEqual(['walk']);
  });

  it('nothing without the flag, the server capability, or on an envelope that is not open', () => {
    expect(hostableSigners(env(), ctxWith(true), false)).toEqual([]);
    expect(hostableSigners(env(), ctxWith(false), true)).toEqual([]);
    expect(hostableSigners(env(), ctxWith(undefined), true)).toEqual([]);
    expect(hostableSigners(env({ status: 'COMPLETED' }), ctxWith(true), true)).toEqual([]);
    expect(hostableSigners(env({ status: 'DRAFT' }), ctxWith(true), true)).toEqual([]);
  });

  it('only the user’s own envelope (or manage_all), only from Aramo Sign', () => {
    expect(
      hostableSigners(env({ sender: { id: 'other', name: 'X' } }), ctxWith(true), true),
    ).toEqual([]);
    expect(hostableSigners(env({ source_application: 'aramo-ats' }), ctxWith(true), true)).toEqual(
      [],
    );
  });

  it('signing in order: only when it is their turn', () => {
    expect(
      hostableSigners(
        env({ routing_mode: 'SEQUENTIAL', next_signer_id: 'walk' }),
        ctxWith(true),
        true,
      ).map((r) => r.id),
    ).toEqual(['walk']);
    expect(
      hostableSigners(
        env({ routing_mode: 'SEQUENTIAL', next_signer_id: 'a' }),
        ctxWith(true),
        true,
      ),
    ).toEqual([]);
  });

  it('never a signer who signed or declined, an emailed signer, or a copy recipient', () => {
    const d = env({
      recipients: [
        rec('s', { recipient_kind: 'IN_PERSON_SIGNER', status: 'SIGNED' }),
        rec('d', { recipient_kind: 'IN_PERSON_SIGNER', status: 'DECLINED' }),
        rec('e', { recipient_kind: 'SIGNER' }),
        rec('c', { recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_SEND' }),
      ],
    });
    expect(hostableSigners(d, ctxWith(true), true)).toEqual([]);
  });
});
