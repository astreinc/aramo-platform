// M-A12 W1-D.2 — Agreements: the sort control (newest, oldest, name A–Z, status), the
// Voided/Canceled filter, and (W1-A.4) "Sign now" for a sent envelope the server says the
// caller can sign (`can_self_sign_now`).
import {
  CHIP_FILTERS,
  filterAgreements,
  mergeAgreements,
  pillFor,
  selfSignNow,
  sortAgreements,
} from '../agreementsModel';
import { swipeActionsFor } from '../rowActionRules';
import { CTX_OWNER, sent } from './fixtures';
import type { SenderContext } from '../types';

const rows = () =>
  mergeAgreements(
    [
      sent('COMPLETED', { subject: 'Bravo', last_activity_at: '2026-10-23T10:00:00.000Z' }),
      sent('VOIDED', { subject: 'alpha', last_activity_at: '2026-10-21T10:00:00.000Z' }),
      sent('IN_PROGRESS', { subject: 'Charlie', last_activity_at: '2026-10-22T10:00:00.000Z' }),
    ],
    null,
  );

describe('Agreements sort and filter', () => {
  it('sorts newest, oldest, name A–Z and by status', () => {
    expect(sortAgreements(rows(), 'newest').map((r) => r.subject)).toEqual(['Bravo', 'Charlie', 'alpha']);
    expect(sortAgreements(rows(), 'oldest').map((r) => r.subject)).toEqual(['alpha', 'Charlie', 'Bravo']);
    expect(sortAgreements(rows(), 'name').map((r) => r.subject)).toEqual(['alpha', 'Bravo', 'Charlie']);
    expect(sortAgreements(rows(), 'status').map((r) => r.status)).toEqual(['IN_PROGRESS', 'COMPLETED', 'VOIDED']);
  });

  it('Voided/Canceled lists only voided envelopes; it lives in the filter sheet, not the chips', () => {
    expect(filterAgreements(rows(), 'voided').map((r) => r.subject)).toEqual(['alpha']);
    expect(CHIP_FILTERS).not.toContain('voided');
  });

  it('can_self_sign_now: Needs me pill and a Sign swipe action', () => {
    const [row] = mergeAgreements([sent('IN_PROGRESS', { can_self_sign_now: true } as never)], null);
    expect(selfSignNow(row!)).toBe(true);
    expect(pillFor(row!)).toBe('NEEDS_ME');
    expect(swipeActionsFor(row!, { sender: CTX_OWNER as unknown as SenderContext, online: true })[0]?.kind).toBe('sign');
    const [done] = mergeAgreements([sent('COMPLETED', { can_self_sign_now: true } as never)], null);
    expect(selfSignNow(done!)).toBe(false);
  });
});
