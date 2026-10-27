import type { DraftRecipient } from '../draftModel';
import { parseEnvelope, payloadFromServer } from '../draftModel';
import {
  changeKind,
  checkAdd,
  copyTimingLabel,
  isDuplicateEmail,
  recipientsToWire,
  wireOrder,
} from '../recipientRoles';

const r = (key: string, over: Partial<DraftRecipient> = {}): DraftRecipient => ({
  key,
  serverId: null,
  name: key.toUpperCase(),
  email: `${key}@example.com`,
  ...over,
});

describe('recipient role rules (M-A5 §1.4, §2.1, §3.5, §4.1)', () => {
  it('limits signing and copy recipients separately (10 + 10)', () => {
    const signers = Array.from({ length: 10 }, (_, i) => r(`s${i}`));
    expect(checkAdd(signers, 'SIGNER', 'x@example.com')).toBe('signers_full');
    expect(checkAdd(signers, 'IN_PERSON_SIGNER', '')).toBe('signers_full');
    expect(checkAdd(signers, 'RECEIVES_COPY', 'x@example.com')).toBe('ok');
    const copies = Array.from({ length: 10 }, (_, i) =>
      r(`c${i}`, { kind: 'RECEIVES_COPY', copyDelivery: 'ON_SEND' }),
    );
    expect(checkAdd(copies, 'RECEIVES_COPY', 'x@example.com')).toBe('copies_full');
    expect(checkAdd(copies, 'SIGNER', 'x@example.com')).toBe('ok');
  });

  it('emails are distinct across all kinds; a missing email never duplicates', () => {
    const list = [
      r('a', { kind: 'RECEIVES_COPY', copyDelivery: 'BOTH' }),
      r('b', { email: '', kind: 'IN_PERSON_SIGNER' }),
    ];
    expect(checkAdd(list, 'SIGNER', 'A@EXAMPLE.com')).toBe('duplicate');
    expect(checkAdd(list, 'IN_PERSON_SIGNER', '')).toBe('ok');
    expect(isDuplicateEmail(list, '')).toBe(false);
    expect(isDuplicateEmail(list, 'a@example.com', 'a')).toBe(false);
  });

  it('email is optional for an in-person signer only', () => {
    expect(checkAdd([], 'IN_PERSON_SIGNER', '')).toBe('ok');
    expect(checkAdd([], 'SIGNER', '')).toBe('email_required');
    expect(checkAdd([], 'RECEIVES_COPY', ' ')).toBe('email_required');
  });

  it('changing to Copy drops fields and defaults the timing; leaving Copy clears it', () => {
    const out = changeKind([r('a')], 'a', 'RECEIVES_COPY');
    expect(out).toMatchObject({ ok: true, dropsFields: true });
    if (!out.ok) throw new Error('refused');
    expect(out.recipients[0]).toMatchObject({
      kind: 'RECEIVES_COPY',
      copyDelivery: 'ON_COMPLETION',
    });
    const back = changeKind(out.recipients, 'a', 'IN_PERSON_SIGNER');
    expect(back).toMatchObject({ ok: true, dropsFields: false });
    if (!back.ok) throw new Error('refused');
    expect(back.recipients[0]).toMatchObject({ kind: 'IN_PERSON_SIGNER', copyDelivery: null });
  });

  it('refuses a change that breaks a limit', () => {
    const signers = Array.from({ length: 10 }, (_, i) => r(`s${i}`));
    const cc = r('cc', { kind: 'RECEIVES_COPY', copyDelivery: 'ON_SEND' });
    expect(changeKind([...signers, cc], 'cc', 'SIGNER')).toEqual({
      ok: false,
      reason: 'signers_full',
    });
    const copies = Array.from({ length: 10 }, (_, i) =>
      r(`c${i}`, { kind: 'RECEIVES_COPY', copyDelivery: 'ON_SEND' }),
    );
    expect(changeKind([...copies, r('a')], 'a', 'RECEIVES_COPY')).toEqual({
      ok: false,
      reason: 'copies_full',
    });
  });

  it('wire: signing in order, then copies; assign_to_me only on a SIGNER; email null when absent', () => {
    const list = [
      r('cc', { kind: 'RECEIVES_COPY', copyDelivery: 'BOTH', serverId: 'srv-cc' }),
      r('me', { assignToMe: true }),
      r('walk', { email: '', kind: 'IN_PERSON_SIGNER' }),
      r('ip', { kind: 'IN_PERSON_SIGNER', assignToMe: true }),
    ];
    expect(wireOrder(list).map((x) => x.key)).toEqual(['me', 'walk', 'ip', 'cc']);
    expect(recipientsToWire(list)).toEqual([
      { name: 'ME', email: 'me@example.com', recipient_kind: 'SIGNER', assign_to_me: true },
      { name: 'WALK', email: null, recipient_kind: 'IN_PERSON_SIGNER' },
      { name: 'IP', email: 'ip@example.com', recipient_kind: 'IN_PERSON_SIGNER' },
      {
        id: 'srv-cc',
        name: 'CC',
        email: 'cc@example.com',
        recipient_kind: 'RECEIVES_COPY',
        copy_delivery: 'BOTH',
      },
    ]);
  });

  it('drafts saved before M-A5 (no kind) are signers', () => {
    expect(recipientsToWire([r('old')])).toEqual([
      { name: 'OLD', email: 'old@example.com', recipient_kind: 'SIGNER' },
    ]);
  });

  it('reads kinds, timing and assigned_to_me from the sender detail', () => {
    const env = parseEnvelope({
      id: 'e',
      subject: 'S',
      status: 'DRAFT',
      editable: true,
      revision: 3,
      recipients: [
        {
          id: 'c',
          name: 'C',
          email: 'c@example.com',
          status: 'PENDING',
          signing_order: 2,
          recipient_kind: 'RECEIVES_COPY',
          copy_delivery: 'ON_SEND',
          assigned_to_me: false,
        },
        {
          id: 'w',
          name: 'W',
          email: null,
          status: 'PENDING',
          signing_order: 1,
          recipient_kind: 'IN_PERSON_SIGNER',
          copy_delivery: null,
          assigned_to_me: false,
        },
        {
          id: 'm',
          name: 'M',
          email: 'm@example.com',
          status: 'PENDING',
          signing_order: 0,
          recipient_kind: 'SIGNER',
          copy_delivery: null,
          assigned_to_me: true,
        },
      ],
    });
    const { payload } = payloadFromServer(env, '"e.3"', new Map());
    expect(
      payload.recipients.map((x) => [x.key, x.kind, x.copyDelivery, x.assignToMe, x.email]),
    ).toEqual([
      ['m', 'SIGNER', null, true, 'm@example.com'],
      ['w', 'IN_PERSON_SIGNER', null, false, ''],
      ['c', 'RECEIVES_COPY', 'ON_SEND', false, 'c@example.com'],
    ]);
  });

  it('labels the copy timing', () => {
    expect(copyTimingLabel('ON_SEND')).toBe('When sent');
    expect(copyTimingLabel('ON_COMPLETION')).toBe('After completion');
    expect(copyTimingLabel('BOTH')).toBe('Both');
  });
});
