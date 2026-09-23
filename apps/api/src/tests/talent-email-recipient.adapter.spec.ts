import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import type { TalentRecordRepository } from '@aramo/talent-record';

import { TalentEmailRecipientAdapter } from '../microsoft/talent-email-recipient.adapter.js';
import { TalentEmailUnavailableError } from '../microsoft/email-recipient-resolver.port.js';

// COMM-C4 (RCE-1) — the recipient resolver reads the AUTHORITATIVE Talent email
// tenant-scoped. `findContactByIds` filters on (tenant_id, record_status='live'),
// so a cross-tenant or absent Talent yields no entry → fail closed. Proves the
// adapter cannot produce an address outside the caller's tenant, and cannot
// substitute a fallback when email1 is absent.

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const TALENT = randomUUID();
const AUTH_EMAIL = 'authoritative@talent.example';

function contact(email: string | null) {
  return { email, phone: null, city: null, state: null, work_authorization: null, desired_pay: null };
}

// Models the tenant-scoped repository: the live TalentRecord (TENANT_A, TALENT)
// has AUTH_EMAIL; any other (tenant, id) pair resolves to nothing.
class FakeTalentRepo {
  constructor(private readonly email: string | null = AUTH_EMAIL) {}
  async findContactByIds(tenant_id: string, ids: readonly string[]) {
    const out = new Map<string, ReturnType<typeof contact>>();
    for (const id of ids) {
      if (tenant_id === TENANT_A && id === TALENT) out.set(id, contact(this.email));
    }
    return out;
  }
}

function adapterWith(email: string | null = AUTH_EMAIL): TalentEmailRecipientAdapter {
  return new TalentEmailRecipientAdapter(new FakeTalentRepo(email) as unknown as TalentRecordRepository);
}

describe('TalentEmailRecipientAdapter (COMM-C4 recipient authority)', () => {
  it('resolves the Talent authoritative email1 within the tenant', async () => {
    const email = await adapterWith().resolveRecipientEmail({ tenant_id: TENANT_A, talent_record_id: TALENT });
    expect(email).toBe(AUTH_EMAIL);
  });

  it('a cross-tenant Talent yields NO address → fails closed', async () => {
    await expect(
      adapterWith().resolveRecipientEmail({ tenant_id: TENANT_B, talent_record_id: TALENT }),
    ).rejects.toBeInstanceOf(TalentEmailUnavailableError);
  });

  it('a Talent without email1 fails closed (no fallback address)', async () => {
    await expect(
      adapterWith(null).resolveRecipientEmail({ tenant_id: TENANT_A, talent_record_id: TALENT }),
    ).rejects.toBeInstanceOf(TalentEmailUnavailableError);
  });
});
