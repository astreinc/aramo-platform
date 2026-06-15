import { describe, expect, it, vi } from 'vitest';

import { ConsentRepository } from './consent.repository.js';
import type { PrismaService } from './prisma/prisma.service.js';

function repoWith(events: unknown[]): ConsentRepository {
  return new ConsentRepository({
    talentConsentEvent: { findMany: vi.fn().mockResolvedValue(events) },
  } as unknown as PrismaService);
}

const now = Date.now();
const at = (msAgo: number) => new Date(now - msAgo);
const exp = (msAhead: number) => new Date(now + msAhead);
const DAY = 86_400_000;

describe('ConsentRepository.findContactingConsentSummaryForTalentIds', () => {
  it('maps the contacting-scope state to the 3-value summary', async () => {
    const repo = repoWith([
      // granted, no expiry → contactable
      { talent_id: 'g', action: 'granted', captured_method: 'self_signup', occurred_at: at(1000), expires_at: null },
      // granted, expires in 10d → expiring_lt_30d
      { talent_id: 'e', action: 'granted', captured_method: 'self_signup', occurred_at: at(1000), expires_at: exp(10 * DAY) },
      // granted then later revoked (same source) → do_not_contact
      { talent_id: 'r', action: 'granted', captured_method: 'self_signup', occurred_at: at(2000), expires_at: null },
      { talent_id: 'r', action: 'revoked', captured_method: 'self_signup', occurred_at: at(1000), expires_at: null },
    ]);
    const m = await repo.findContactingConsentSummaryForTalentIds({
      tenant_id: 't',
      talent_ids: ['g', 'e', 'r', 'x'],
    });
    expect(m.get('g')).toBe('contactable');
    expect(m.get('e')).toBe('expiring_lt_30d');
    expect(m.get('r')).toBe('do_not_contact');
    expect(m.has('x')).toBe(false); // no events → caller defaults to do_not_contact
  });

  it('returns empty without querying for an empty id set', async () => {
    const findMany = vi.fn();
    const repo = new ConsentRepository({
      talentConsentEvent: { findMany },
    } as unknown as PrismaService);
    const m = await repo.findContactingConsentSummaryForTalentIds({
      tenant_id: 't',
      talent_ids: [],
    });
    expect(m.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
