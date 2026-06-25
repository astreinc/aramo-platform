import { describe, expect, it } from 'vitest';

import {
  DISPLAYED_STATUSES,
  deriveDisplayedStatus,
} from '../lib/tenant-user/invitation-token.js';

// Invite-S3 (§0) — the backend displayed-status derivation. Mirrors the FE
// helper (apps/ats-web/src/users/user-status.ts) so the server-side action
// gating (resend/revoke/edit-email guards) and the FE rendering agree.
describe('deriveDisplayedStatus (§0 — backend)', () => {
  it('is_active=false OVERRIDES the lifecycle axis → INACTIVE', () => {
    for (const s of ['INVITED', 'ACCEPTED', 'ACTIVE', 'FAILED']) {
      expect(deriveDisplayedStatus(false, s)).toBe('INACTIVE');
    }
  });

  it('is_active=true → the invite_status straight through', () => {
    expect(deriveDisplayedStatus(true, 'INVITED')).toBe('INVITED');
    expect(deriveDisplayedStatus(true, 'ACCEPTED')).toBe('ACCEPTED');
    expect(deriveDisplayedStatus(true, 'ACTIVE')).toBe('ACTIVE');
    expect(deriveDisplayedStatus(true, 'FAILED')).toBe('FAILED');
  });

  it('an unknown invite_status on an active membership projects to ACTIVE', () => {
    expect(deriveDisplayedStatus(true, 'SOMETHING_NEW')).toBe('ACTIVE');
  });

  it('exposes exactly the 5 displayed statuses', () => {
    expect([...DISPLAYED_STATUSES]).toEqual([
      'INVITED',
      'ACCEPTED',
      'ACTIVE',
      'INACTIVE',
      'FAILED',
    ]);
  });
});
