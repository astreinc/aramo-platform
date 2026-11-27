// LIST-SELF-SIGN-1 (UAT 2026-11-27) — the app uses the shared rule: a self-sign session first,
// then the server's inbox item (same as Sign web).
import { inboxItemToSign, mergeAgreements, selfSignNow, type AgreementRow } from '../agreementsModel';
import type { SenderListItem } from '../types';
import { sent } from './fixtures';

const row = (e: SenderListItem): AgreementRow => mergeAgreements([e], null)[0]!;

describe('Sign from a sent row (shared listSignRoute)', () => {
  it('a self-sign envelope with an inbox item resumes by self-sign, never the inbox', () => {
    const r = row({ ...sent('SENT'), awaiting_you: true, can_self_sign_now: true, my_inbox_item_id: 'handle-1' } as SenderListItem);
    expect(selfSignNow(r)).toBe(true);
    expect(inboxItemToSign(r)).toBeNull();
  });

  it('an emailed envelope waiting for the user signs through its inbox item', () => {
    const r = row({ ...sent('IN_PROGRESS'), awaiting_you: true, can_self_sign_now: false, my_inbox_item_id: 'b-1' } as SenderListItem);
    expect(selfSignNow(r)).toBe(false);
    expect(inboxItemToSign(r)).toBe('b-1');
  });

  it('nothing on a finished envelope', () => {
    const r = row({ ...sent('COMPLETED'), awaiting_you: true, can_self_sign_now: true, my_inbox_item_id: 'b-1' } as SenderListItem);
    expect(selfSignNow(r)).toBe(false);
    expect(inboxItemToSign(r)).toBeNull();
  });
});
