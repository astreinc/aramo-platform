import { describe, expect, it } from 'vitest';

import {
  lifecycleActionsFor,
  type LifecycleActionContext,
  type LifecycleActionId,
} from './approval-affordance';
import type { RecruitingStatus } from './types';

// L1-E — the named LIFECYCLE-ACTION affordance gate (pure). Mirrors the BE
// TRANSITION_MATRIX ALLOW cells (per status × scope) + ACTION_TARGET_STATUS
// targets + the SoD suppression of self-Approve; the lifecycle-action-drift spec
// fs-reads the BE authority and cross-checks. Cosmetic: the BE policy engine +
// in-service SoD gate are authoritative (an illegal / scope-less / self-approve
// action 403s regardless); this exists to guide, not to authorize.

const READ = ['requisition:read'];
const EDIT = ['requisition:read', 'requisition:edit'];
const EDIT_STATUS = ['requisition:read', 'requisition:edit:status'];
const APPROVE = ['requisition:read', 'requisition:edit', 'requisition:approve'];

const NO_CTX: LifecycleActionContext = { submitterId: null, actorId: null };
const ids = (
  status: RecruitingStatus,
  scopes: readonly string[],
  ctx: LifecycleActionContext = NO_CTX,
): LifecycleActionId[] => lifecycleActionsFor(status, scopes, ctx).map((a) => a.action);

describe('lifecycleActionsFor — approval sub-workflow', () => {
  it('draft + edit scope → Submit for approval (→ pending_approval)', () => {
    expect(lifecycleActionsFor('draft', EDIT, NO_CTX)).toEqual([
      { action: 'SUBMIT_FOR_APPROVAL', label: 'Submit for approval', toStatus: 'pending_approval' },
    ]);
  });

  it('draft + status-only edit scope → Submit for approval (edit:status suffices)', () => {
    expect(ids('draft', EDIT_STATUS)).toEqual(['SUBMIT_FOR_APPROVAL']);
  });

  it('draft WITHOUT any edit scope → nothing', () => {
    expect(ids('draft', READ)).toEqual([]);
  });

  it('pending_approval + requisition:approve (different approver) → Approve + Reject', () => {
    expect(lifecycleActionsFor('pending_approval', APPROVE, { submitterId: 'other', actorId: 'me' })).toEqual([
      { action: 'APPROVE', label: 'Approve', toStatus: 'open' },
      { action: 'REJECT', label: 'Reject', toStatus: 'draft' },
    ]);
  });

  it('pending_approval WITHOUT requisition:approve → nothing (a full editor cannot approve/reject)', () => {
    expect(ids('pending_approval', EDIT)).toEqual([]);
  });
});

describe('lifecycleActionsFor — segregation of duties', () => {
  it('the SUBMITTER (self) sees Reject but NOT Approve (self-approval suppressed)', () => {
    expect(ids('pending_approval', APPROVE, { submitterId: 'me', actorId: 'me' })).toEqual(['REJECT']);
  });

  it('a DIFFERENT approver sees BOTH Approve and Reject', () => {
    expect(ids('pending_approval', APPROVE, { submitterId: 'someone-else', actorId: 'me' })).toEqual([
      'APPROVE',
      'REJECT',
    ]);
  });

  it('an unknown submitter (null) is not self — Approve stays available', () => {
    expect(ids('pending_approval', APPROVE, { submitterId: null, actorId: 'me' })).toContain('APPROVE');
  });
});

describe('lifecycleActionsFor — the four original transitions (canEditStatus)', () => {
  it('open → Close submittals + Put on hold + Close + Cancel (NO Reopen; open cannot reopen)', () => {
    expect(ids('open', EDIT)).toEqual(['CLOSE_SUBMITTALS', 'PUT_ON_HOLD', 'CLOSE', 'CANCEL']);
  });

  it('lead → Reopen + Put on hold + Close + Cancel', () => {
    expect(ids('lead', EDIT)).toEqual(['REOPEN', 'PUT_ON_HOLD', 'CLOSE', 'CANCEL']);
  });

  it('on_hold → Reopen + Close + Cancel (NO Put on hold from on_hold)', () => {
    expect(ids('on_hold', EDIT)).toEqual(['REOPEN', 'CLOSE', 'CANCEL']);
  });

  it('submittals_closed → Reopen + Put on hold + Close + Cancel', () => {
    expect(ids('submittals_closed', EDIT)).toEqual(['REOPEN', 'PUT_ON_HOLD', 'CLOSE', 'CANCEL']);
  });

  it('closed → Reopen ONLY (a canceled requisition is dead → nothing)', () => {
    expect(ids('closed', EDIT)).toEqual(['REOPEN']);
    expect(ids('canceled', EDIT)).toEqual([]);
  });

  it('gated archived → nothing', () => {
    expect(ids('archived', EDIT)).toEqual([]);
  });
});

describe('lifecycleActionsFor — RBAC gating', () => {
  it('NO edit-status scope → none of Close / Reopen / Hold / Cancel / Close-submittals', () => {
    for (const status of ['open', 'lead', 'on_hold', 'submittals_closed', 'closed'] as const) {
      expect(ids(status, READ)).toEqual([]);
    }
  });

  it('edit-status alone does NOT unlock Approve/Reject (approve scope required)', () => {
    expect(ids('pending_approval', EDIT_STATUS, { submitterId: 'x', actorId: 'me' })).toEqual([]);
  });

  it('Close submittals appears on `open` ONLY, and only with edit-status', () => {
    expect(ids('open', EDIT)).toContain('CLOSE_SUBMITTALS');
    for (const status of ['lead', 'on_hold', 'submittals_closed', 'closed', 'draft'] as const) {
      expect(ids(status, EDIT)).not.toContain('CLOSE_SUBMITTALS');
    }
    expect(ids('open', READ)).not.toContain('CLOSE_SUBMITTALS');
  });
});
