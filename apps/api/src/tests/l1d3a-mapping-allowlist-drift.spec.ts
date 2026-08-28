import { describe, expect, it } from 'vitest';
import { MAPPING_ADMIN_ALLOWED_ACTIONS } from '@aramo/integration';
import { EXTERNAL_LIFECYCLE_ACTIONS } from '@aramo/requisition';

// L1-D3-A (D-1) — mapping-admin allowlist drift guard.
//
// The integration lib deliberately owns its OWN bounded external-action vocabulary
// (MAPPING_ADMIN_ALLOWED_ACTIONS) rather than importing the @aramo/requisition
// runtime allowlist — importing it would add a new nx edge and couple the
// integration schema to the requisition action enum (the bare-String mapped_action
// column exists precisely to avoid that). This test lives in apps/api, which
// LEGITIMATELY depends on BOTH libs, and is the single point that catches drift:
// if the canonical external-authority action set ever changes, the mapping-admin
// allowlist must change with it — or this fails.
describe('L1-D3-A mapping-admin allowlist ⟷ requisition external-action parity', () => {
  it('MAPPING_ADMIN_ALLOWED_ACTIONS is EXACTLY EXTERNAL_LIFECYCLE_ACTIONS', () => {
    const admin = [...MAPPING_ADMIN_ALLOWED_ACTIONS].sort();
    const canonical = [...EXTERNAL_LIFECYCLE_ACTIONS].sort();
    expect(admin).toEqual(canonical);
  });

  it('is exactly the four operational actions (no approval sub-workflow leaks)', () => {
    // Explicit belt-and-suspenders: SUBMIT_FOR_APPROVAL / APPROVE / REJECT are
    // internal governance and must NEVER be externally authorable (R2).
    expect([...MAPPING_ADMIN_ALLOWED_ACTIONS].sort()).toEqual(
      ['CANCEL', 'CLOSE', 'PUT_ON_HOLD', 'REOPEN'],
    );
    for (const forbidden of ['SUBMIT_FOR_APPROVAL', 'APPROVE', 'REJECT']) {
      expect(MAPPING_ADMIN_ALLOWED_ACTIONS).not.toContain(forbidden);
    }
  });
});
