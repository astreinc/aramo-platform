import { describe, expect, it, vi } from 'vitest';

import { IdentityInterviewerValidator } from '../interviews/interviewer-validator.adapter.js';

// Slice B (Calendar/Interview §9) — the interviewer tenant-user validation refusal proof.
// The adapter resolves the tenant's ACTIVE member roster and refuses any interviewer id
// that is not a current tenant user (this also covers a cross-tenant id, which never
// appears in THIS tenant's roster). An empty id list issues no identity read.

function makeIdentity(activeIds: readonly string[]) {
  return {
    listAssignableTenantUsers: vi.fn(async () =>
      activeIds.map((id) => ({ user_id: id, display_name: null })),
    ),
  };
}

describe('IdentityInterviewerValidator', () => {
  it('passes when every interviewer is an active tenant user', async () => {
    const identity = makeIdentity(['u1', 'u2']);
    const v = new IdentityInterviewerValidator(identity as never);
    await expect(
      v.assertValidTenantInterviewers({
        tenant_id: 't',
        interviewer_user_ids: ['u1', 'u2'],
        requestId: 'r',
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses an interviewer that is not a current tenant user (incl. cross-tenant) — VALIDATION_ERROR 422', async () => {
    const identity = makeIdentity(['u1']);
    const v = new IdentityInterviewerValidator(identity as never);
    await expect(
      v.assertValidTenantInterviewers({
        tenant_id: 't',
        interviewer_user_ids: ['u1', 'foreign-or-unknown'],
        requestId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 });
  });

  it('is a no-op for an empty interviewer list (no identity read)', async () => {
    const identity = makeIdentity([]);
    const v = new IdentityInterviewerValidator(identity as never);
    await v.assertValidTenantInterviewers({
      tenant_id: 't',
      interviewer_user_ids: [],
      requestId: 'r',
    });
    expect(identity.listAssignableTenantUsers).not.toHaveBeenCalled();
  });
});
