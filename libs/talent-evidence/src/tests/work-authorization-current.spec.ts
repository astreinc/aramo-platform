import { describe, expect, it } from 'vitest';

import { selectCurrentWorkAuthorization } from '../lib/work-authorization-current.js';
import type { TalentWorkAuthorizationRow } from '../lib/talent-evidence.repository.js';

// TALENT-INTEL-1 TI-1G §2 — deterministic current-selection over append-only
// work-auth history. NOT latest-row-wins: future/expired assertions are excluded;
// among the eligible the newest-asserted wins; NULL temporal bounds are always
// time-eligible (recruiter stated no window — never invented).

const NOW = new Date('2026-06-01T00:00:00Z');

function row(over: Partial<TalentWorkAuthorizationRow> & { id: string; asserted_at: Date }): TalentWorkAuthorizationRow {
  return {
    talent_id: 'tal', tenant_id: 'ten',
    work_authorization_status: 'VISA_HOLDER',
    authorized_to_work_in: [], visa_type: null, requires_sponsorship: false,
    updated_at: over.asserted_at,
    effective_from: null, effective_to: null, expires_at: null,
    ...over,
  } as TalentWorkAuthorizationRow;
}

describe('selectCurrentWorkAuthorization (TI-1G §2)', () => {
  it('empty history → null', () => {
    expect(selectCurrentWorkAuthorization([], NOW)).toBeNull();
  });

  it('newest-ASSERTED wins over an older assertion (OPT → H-1B → PR history)', () => {
    const opt = row({ id: 'a', asserted_at: new Date('2024-01-01T00:00:00Z'), work_authorization_status: 'VISA_HOLDER' });
    const h1b = row({ id: 'b', asserted_at: new Date('2025-01-01T00:00:00Z'), work_authorization_status: 'VISA_HOLDER' });
    const pr = row({ id: 'c', asserted_at: new Date('2026-01-01T00:00:00Z'), work_authorization_status: 'PERMANENT_RESIDENT' });
    const cur = selectCurrentWorkAuthorization([opt, pr, h1b], NOW);
    expect(cur?.id).toBe('c');
    expect(cur?.work_authorization_status).toBe('PERMANENT_RESIDENT');
  });

  it('excludes an EXPIRED assertion (expires_at < now) even if newest-asserted', () => {
    const expired = row({ id: 'new-expired', asserted_at: new Date('2026-05-01T00:00:00Z'), expires_at: new Date('2026-05-15') });
    const live = row({ id: 'older-live', asserted_at: new Date('2026-01-01T00:00:00Z') });
    expect(selectCurrentWorkAuthorization([expired, live], NOW)?.id).toBe('older-live');
  });

  it('excludes a FUTURE-dated assertion (effective_from > now)', () => {
    const future = row({ id: 'future', asserted_at: new Date('2026-05-20T00:00:00Z'), effective_from: new Date('2026-09-01') });
    const live = row({ id: 'live', asserted_at: new Date('2026-01-01T00:00:00Z') });
    expect(selectCurrentWorkAuthorization([future, live], NOW)?.id).toBe('live');
  });

  it('all assertions ineligible → null', () => {
    const expired = row({ id: 'x', asserted_at: new Date('2026-05-01T00:00:00Z'), expires_at: new Date('2026-05-02') });
    expect(selectCurrentWorkAuthorization([expired], NOW)).toBeNull();
  });

  it('deterministic tiebreak on equal asserted_at (updated_at, then id)', () => {
    const at = new Date('2026-02-02T00:00:00Z');
    const r1 = row({ id: 'aaa', asserted_at: at, updated_at: at });
    const r2 = row({ id: 'zzz', asserted_at: at, updated_at: at });
    expect(selectCurrentWorkAuthorization([r1, r2], NOW)?.id).toBe('zzz');
    expect(selectCurrentWorkAuthorization([r2, r1], NOW)?.id).toBe('zzz'); // order-independent
  });
});
