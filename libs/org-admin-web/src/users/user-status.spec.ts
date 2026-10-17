import { describe, expect, it } from 'vitest';

import {
  STATUS_TONE,
  actionsForStatus,
  deriveDisplayedStatus,
  type DisplayedStatus,
} from './user-status';

// Invite-S3 (§0) — the displayed-status derivation. is_active=false OVERRIDES
// the lifecycle axis (INACTIVE); else the invite_status drives it.
describe('deriveDisplayedStatus (§0 precedence)', () => {
  it('is_active=false → INACTIVE regardless of invite_status', () => {
    for (const invite_status of ['INVITED', 'ACCEPTED', 'ACTIVE', 'FAILED']) {
      expect(deriveDisplayedStatus({ is_active: false, invite_status })).toBe(
        'INACTIVE',
      );
    }
  });

  it('is_active=true → reads the invite_status straight through', () => {
    expect(
      deriveDisplayedStatus({ is_active: true, invite_status: 'INVITED' }),
    ).toBe('INVITED');
    expect(
      deriveDisplayedStatus({ is_active: true, invite_status: 'ACCEPTED' }),
    ).toBe('ACCEPTED');
    expect(
      deriveDisplayedStatus({ is_active: true, invite_status: 'ACTIVE' }),
    ).toBe('ACTIVE');
    expect(
      deriveDisplayedStatus({ is_active: true, invite_status: 'FAILED' }),
    ).toBe('FAILED');
  });

  it('an unknown invite_status on an active membership projects to ACTIVE', () => {
    expect(
      deriveDisplayedStatus({ is_active: true, invite_status: 'WEIRD' }),
    ).toBe('ACTIVE');
  });
});

// §2 — the badge tone map covers every displayed status.
describe('STATUS_TONE (§2)', () => {
  it('maps each of the 5 states to its locked tone', () => {
    expect(STATUS_TONE.INVITED).toBe('warn');
    expect(STATUS_TONE.ACCEPTED).toBe('info');
    expect(STATUS_TONE.ACTIVE).toBe('ok');
    expect(STATUS_TONE.INACTIVE).toBe('neutral');
    expect(STATUS_TONE.FAILED).toBe('danger');
  });
});

// §3 — the action matrix. Edit-roles is universal; the state-dependent verbs
// follow the locked rulings.
describe('actionsForStatus (§3 matrix)', () => {
  const all: DisplayedStatus[] = [
    'INVITED',
    'ACCEPTED',
    'ACTIVE',
    'INACTIVE',
    'FAILED',
  ];

  it('edit-roles is available in EVERY state', () => {
    for (const s of all) expect(actionsForStatus(s).editRoles).toBe(true);
  });

  it('INVITED → resend invitation + revoke (no enable/disable/edit-email)', () => {
    const a = actionsForStatus('INVITED');
    expect(a).toMatchObject({
      resend: 'invitation',
      revoke: true,
      enable: false,
      disable: false,
      editEmail: false,
    });
  });

  it('ACCEPTED → resend confirmation + revoke', () => {
    const a = actionsForStatus('ACCEPTED');
    expect(a.resend).toBe('confirmation');
    expect(a.revoke).toBe(true);
  });

  it('ACTIVE → disable only', () => {
    const a = actionsForStatus('ACTIVE');
    expect(a).toMatchObject({
      disable: true,
      enable: false,
      resend: null,
      revoke: false,
    });
  });

  it('INACTIVE → enable only', () => {
    const a = actionsForStatus('INACTIVE');
    expect(a).toMatchObject({
      enable: true,
      disable: false,
      resend: null,
      revoke: false,
    });
  });

  it('FAILED → edit-email + resend invitation + revoke', () => {
    const a = actionsForStatus('FAILED');
    expect(a).toMatchObject({
      editEmail: true,
      resend: 'invitation',
      revoke: true,
    });
  });
});
