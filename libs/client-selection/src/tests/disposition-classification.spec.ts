import { describe, expect, it } from 'vitest';

import {
  considerationEffect,
  isWithdrawReasonCode,
  WITHDRAW_REASON_EFFECT,
} from '../lib/disposition-classification.js';

// L3-E(2) — the closed, deterministic classifier. DECLINED terminates by default;
// WITHDRAWN is cause-sensitive via a closed reason set; an unclassifiable WITHDRAWN
// returns null (the orchestrator turns that into a deterministic 422 — never a guess).

describe('considerationEffect (L3-E(2) disposition classification)', () => {
  it('DECLINED always TERMINATES (terminal by default, no reason required)', () => {
    expect(considerationEffect({ to_state: 'DECLINED' })).toBe('TERMINATES_CONSIDERATION');
    expect(considerationEffect({ to_state: 'DECLINED', reason_code: 'anything' })).toBe(
      'TERMINATES_CONSIDERATION',
    );
  });

  it('WITHDRAWN terminal causes → TERMINATES', () => {
    for (const rc of ['TALENT_WITHDREW', 'TALENT_UNAVAILABLE', 'RECRUITER_DISPOSITIONED']) {
      expect(considerationEffect({ to_state: 'WITHDRAWN', reason_code: rc })).toBe(
        'TERMINATES_CONSIDERATION',
      );
    }
  });

  it('WITHDRAWN preserving causes → PRESERVES qualification', () => {
    for (const rc of ['ADMIN_CORRECTION', 'RESUBMITTAL', 'CLIENT_PROCESS_CANCELLED']) {
      expect(considerationEffect({ to_state: 'WITHDRAWN', reason_code: rc })).toBe(
        'PRESERVES_QUALIFICATION',
      );
    }
  });

  it('WITHDRAWN with no reason, or an unknown/free-text reason → null (unclassifiable)', () => {
    expect(considerationEffect({ to_state: 'WITHDRAWN' })).toBeNull();
    expect(considerationEffect({ to_state: 'WITHDRAWN', reason_code: 'made up' })).toBeNull();
    expect(considerationEffect({ to_state: 'WITHDRAWN', reason_code: 'terminated' })).toBeNull();
  });

  it('every closed reason maps to exactly one effect (closed + total)', () => {
    for (const [rc, eff] of Object.entries(WITHDRAW_REASON_EFFECT)) {
      expect(isWithdrawReasonCode(rc)).toBe(true);
      expect(['TERMINATES_CONSIDERATION', 'PRESERVES_QUALIFICATION']).toContain(eff);
    }
  });
});
