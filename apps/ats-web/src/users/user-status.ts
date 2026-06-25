// Invite-S3 — the 5-state display model for the Users roster (§0/§2/§3).
//
// The displayed status derives from TWO orthogonal axes that LAYER (they do
// NOT collapse into one field):
//   displayed = (is_active === false) ? INACTIVE : invite_status
// is_active=false (the membership soft-disable) OVERRIDES the lifecycle axis →
// INACTIVE. Otherwise the invite_status value drives it (INVITED | ACCEPTED |
// ACTIVE | FAILED). FAILED is the NET-NEW 4th invite_status value S4's bounce
// ingestion writes; S3 ships the precedence, the badge, and the edit-email
// action so FAILED lights up the moment S4 writes it — but S3 writes NO FAILED.
//
// This mirrors the backend deriveDisplayedStatus (invitation-token.ts) so the
// roster rendering and the server-side action gating agree on the same model.

import type { PillTone } from '../ui';

import type { TenantUserView } from './types';

export const DISPLAYED_STATUSES = [
  'INVITED',
  'ACCEPTED',
  'ACTIVE',
  'INACTIVE',
  'FAILED',
] as const;
export type DisplayedStatus = (typeof DISPLAYED_STATUSES)[number];

// §0 — the precedence. is_active=false wins (INACTIVE); else the invite_status.
// An unknown/forward-compat invite_status on an active membership projects to
// ACTIVE (an active member with a non-pending lifecycle is active).
export function deriveDisplayedStatus(user: {
  is_active: boolean;
  invite_status: string;
}): DisplayedStatus {
  if (user.is_active === false) return 'INACTIVE';
  switch (user.invite_status) {
    case 'INVITED':
      return 'INVITED';
    case 'ACCEPTED':
      return 'ACCEPTED';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'ACTIVE';
  }
}

// §2 — displayed status → StatusPill tone (reuse, no new component).
export const STATUS_TONE: Record<DisplayedStatus, PillTone> = {
  INVITED: 'warn', // amber / pending
  ACCEPTED: 'info', // blue
  ACTIVE: 'ok', // green
  INACTIVE: 'neutral', // grey
  FAILED: 'danger', // red
};

// The operator-facing label under the badge.
export const STATUS_LABEL: Record<DisplayedStatus, string> = {
  INVITED: 'Invited',
  ACCEPTED: 'Accepted',
  ACTIVE: 'Active',
  INACTIVE: 'Disabled',
  FAILED: 'Failed',
};

// §3 — the action matrix as a displayed-status → available-actions map. Edit
// roles is available in EVERY state (admin can fix roles pre- or post-accept).
export interface UserActions {
  readonly editRoles: boolean;
  readonly editEmail: boolean;
  readonly enable: boolean;
  readonly disable: boolean;
  // 'invitation' = invitation email + fresh token; 'confirmation' = login
  // reminder, no token change; null = no resend in this state.
  readonly resend: 'invitation' | 'confirmation' | null;
  readonly revoke: boolean;
}

const MATRIX: Record<DisplayedStatus, UserActions> = {
  INVITED: {
    editRoles: true,
    editEmail: false,
    enable: false,
    disable: false,
    resend: 'invitation',
    revoke: true,
  },
  ACCEPTED: {
    editRoles: true,
    editEmail: false,
    enable: false,
    disable: false,
    resend: 'confirmation',
    revoke: true,
  },
  ACTIVE: {
    editRoles: true,
    editEmail: false,
    enable: false,
    disable: true,
    resend: null,
    revoke: false,
  },
  INACTIVE: {
    editRoles: true,
    editEmail: false,
    enable: true,
    disable: false,
    resend: null,
    revoke: false,
  },
  FAILED: {
    editRoles: true,
    editEmail: true,
    enable: false,
    disable: false,
    resend: 'invitation',
    revoke: true,
  },
};

export function actionsForStatus(status: DisplayedStatus): UserActions {
  return MATRIX[status];
}

export function actionsForUser(user: TenantUserView): UserActions {
  return MATRIX[deriveDisplayedStatus(user)];
}
