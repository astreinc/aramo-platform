import { ApiError } from '@aramo/fe-foundation';
import { describe, expect, it } from 'vitest';

import type { PlatformAuditEvent } from '../platform-api';

import {
  ALLOWED_ACTIONS,
  EMPTY_LIFECYCLE_VALUES,
  LIFECYCLE_ACTIONS,
  REASON_LABEL,
  allowedActions,
  lifecycleValuesComplete,
  reasonLabel,
} from './lifecycle-reasons';
import {
  SLUG_PATTERN,
  alreadyInStatusCopy,
  domainErrorCopy,
  inviteErrorCopy,
  lifecycleErrorCopy,
  ownerInviteErrorCopy,
  provisionErrorCopy,
  slugify,
} from './tenant-errors';
import {
  TENANT_EVENT_LABEL,
  actorLabel,
  billingEventLabel,
  eventLabel,
  subscriptionSourceLabel,
  timelineFrom,
} from './tenant-labels';
import { TENANT_INVITE_ROLES } from './tenant-roles';

// PLATFORM-UX-1 F-3..F-5 — the transition table, the reason config (R-15), the
// error → copy mapping (handoff §6.2, §7; amendment 4) and the human labels.

describe('lifecycle transition table (handoff §7)', () => {
  it('offers exactly the allowed transitions per status', () => {
    expect(ALLOWED_ACTIONS).toEqual({
      PROVISIONED: ['close'],
      ACTIVE: ['suspend', 'offboard'],
      SUSPENDED: ['reactivate', 'offboard'],
      OFFBOARDING: ['close'],
      CLOSED: [],
    });
    expect(allowedActions('UNKNOWN')).toEqual([]);
  });

  it('maps each action to its target status and tone', () => {
    expect(LIFECYCLE_ACTIONS.suspend.to).toBe('SUSPENDED');
    expect(LIFECYCLE_ACTIONS.reactivate.to).toBe('ACTIVE');
    expect(LIFECYCLE_ACTIONS.offboard.to).toBe('OFFBOARDING');
    expect(LIFECYCLE_ACTIONS.close.to).toBe('CLOSED');
    expect(LIFECYCLE_ACTIONS.close.tone).toBe('danger');
    for (const k of ['suspend', 'reactivate', 'offboard'] as const) expect(LIFECYCLE_ACTIONS[k].tone).toBe('privileged');
  });
});

describe('reason config (directive R-15)', () => {
  const codesOf = (k: keyof typeof LIFECYCLE_ACTIONS): string[] =>
    LIFECYCLE_ACTIONS[k].fields.flatMap((f) => (f.key === 'code' ? f.options.map((o) => o.value) : []));

  it('adopts the design per-action reason lists', () => {
    expect(codesOf('suspend')).toEqual(['payment_overdue', 'terms_violation', 'security_incident', 'legal_hold', 'owner_request']);
    expect(codesOf('reactivate')).toEqual(['issue_resolved', 'payment_received', 'suspended_in_error', 'owner_request']);
    expect(codesOf('offboard')).toEqual(['contract_ended', 'owner_request', 'consolidation']);
    expect(codesOf('close')).toEqual(['offboarding_complete', 'never_activated', 'duplicate_tenant', 'owner_request']);
  });

  it('gives every offered code a human label', () => {
    for (const k of Object.keys(LIFECYCLE_ACTIONS) as (keyof typeof LIFECYCLE_ACTIONS)[]) {
      for (const c of codesOf(k)) expect(REASON_LABEL[c]).toBeDefined();
    }
    expect(reasonLabel('payment_overdue')).toBe('Payment overdue');
    expect(reasonLabel('ops_hold')).toBe('Ops hold');
  });

  it('requires the fields per the handoff §7 table', () => {
    const v = EMPTY_LIFECYCLE_VALUES;
    expect(lifecycleValuesComplete('suspend', { ...v, code: 'legal_hold' })).toBe(false);
    expect(lifecycleValuesComplete('suspend', { ...v, code: 'legal_hold', text: 'Court order' })).toBe(true);
    expect(lifecycleValuesComplete('reactivate', { ...v, code: 'issue_resolved' })).toBe(true);
    expect(lifecycleValuesComplete('offboard', { ...v, retention: 'standard_90d' })).toBe(false);
    expect(lifecycleValuesComplete('offboard', { ...v, retention: 'standard_90d', closeAt: '2026-12-01' })).toBe(true);
    expect(lifecycleValuesComplete('close', { ...v, code: 'duplicate_tenant' })).toBe(false);
    expect(lifecycleValuesComplete('close', { ...v, code: 'duplicate_tenant', ack: true })).toBe(true);
  });
});

describe('error → copy', () => {
  const api = (status: number, code: string, details?: Record<string, unknown>, message = 'server says') =>
    new ApiError(status, message, code, details);

  it('maps the provision codes (handoff §6.2)', () => {
    expect(provisionErrorCopy(api(409, 'TENANT_ALREADY_EXISTS'))).toMatchObject({
      kind: 'form',
      step: 1,
      code: 'TENANT_ALREADY_EXISTS',
      message: 'A tenant with this name or slug already exists. Choose a different name or slug.',
    });
    expect(provisionErrorCopy(api(409, 'EMAIL_UNAVAILABLE'))).toMatchObject({ kind: 'form', step: 1, code: 'EMAIL_UNAVAILABLE' });
    expect(provisionErrorCopy(api(502, 'COGNITO_PROVISION_FAILED'))).toMatchObject({
      kind: 'form',
      step: 3,
      message: expect.stringContaining('Nothing was saved'),
    });
    expect(provisionErrorCopy(api(400, 'VALIDATION_ERROR', { reason: 'reserved_slug' }))).toEqual({
      kind: 'field',
      field: 'slug',
      message: 'This address is reserved. Choose a different slug.',
    });
    expect(provisionErrorCopy(api(400, 'VALIDATION_ERROR', { reason: 'invalid_owner_email' }))).toMatchObject({ kind: 'field', field: 'email' });
  });

  it('maps the tenant invite codes (amendment 4)', () => {
    expect(inviteErrorCopy(api(409, 'INVITATION_ALREADY_EXISTS')).message).toBe(
      'This person already has a pending invitation to this tenant.',
    );
    expect(inviteErrorCopy(api(409, 'EMAIL_UNAVAILABLE')).code).toBe('EMAIL_UNAVAILABLE');
    // A refused role combination is a VALIDATION_ERROR: the server message is shown.
    expect(inviteErrorCopy(api(400, 'VALIDATION_ERROR', undefined, 'Interviewer can’t be combined'))).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Interviewer can’t be combined',
    });
  });

  it('maps illegal_transition and "already in that status" (handoff §7)', () => {
    expect(lifecycleErrorCopy(api(422, 'VALIDATION_ERROR', { reason: 'illegal_transition', from: 'CLOSED' }), 'ACTIVE')).toEqual({
      code: 'illegal_transition',
      message: 'This change isn’t allowed from Closed.',
    });
    expect(alreadyInStatusCopy('SUSPENDED').message).toBe('No change: this tenant is already suspended.');
    expect(lifecycleErrorCopy(api(422, 'VALIDATION_ERROR', { reason: 'reason_text_required' }), 'ACTIVE').message).toBe(
      'Add the reason details.',
    );
  });

  it('maps the owner-invite and domain refusals', () => {
    expect(ownerInviteErrorCopy(api(422, 'VALIDATION_ERROR', { reason: 'tenant_not_provisioned' }))).toContain('Provisioned');
    expect(domainErrorCopy(api(409, 'TENANT_DOMAIN_UNAVAILABLE', { reason: 'organization_domain_taken' })).message).toBe(
      'Another organization already holds this domain.',
    );
  });
});

describe('slug rule (handoff §6.2)', () => {
  it('generates the slug from the name', () => {
    expect(slugify('Halvorsen Clinics')).toBe('halvorsen-clinics');
    expect(slugify('Fenwick & Rowe')).toBe('fenwick-and-rowe');
    expect(slugify('  --Café 42!! ')).toBe('caf-42');
    expect(slugify('a'.repeat(39) + ' b')).toBe('a'.repeat(39));
  });
  it('accepts 1–40 chars, lowercase alphanumerics and inner hyphens', () => {
    expect(SLUG_PATTERN.test('a')).toBe(true);
    expect(SLUG_PATTERN.test('north-wind')).toBe(true);
    expect(SLUG_PATTERN.test('-north')).toBe(false);
    expect(SLUG_PATTERN.test('North')).toBe(false);
    expect(SLUG_PATTERN.test('a'.repeat(41))).toBe(false);
  });
});

describe('labels', () => {
  it('labels all 9 tenant audit event types, never the raw name', () => {
    expect(Object.keys(TENANT_EVENT_LABEL)).toHaveLength(9);
    expect(eventLabel('tenant.offboarding_started')).toBe('Offboarding started');
    expect(eventLabel('tenant.lifecycle_transition_rejected')).toBe('Transition rejected');
    expect(eventLabel('tenant.something_new')).toBe('Something new');
  });

  it('labels actors', () => {
    expect(actorLabel('user', 'tenant.suspended')).toBe('Operator');
    expect(actorLabel('user', 'tenant.owner_invite.accepted')).toBe('Tenant owner');
    expect(actorLabel('system')).toBe('System');
  });

  it('labels Sign sources, FREE included', () => {
    expect(subscriptionSourceLabel('FREE')).toBe('Free (Sign Personal)');
    expect(subscriptionSourceLabel('MANUAL')).toBe('Manual (contract)');
    expect(subscriptionSourceLabel('SELF_SERVICE')).toBe('Self-service');
    expect(billingEventLabel('invoice.payment_failed')).toBe('Payment failed');
  });

  it('maps audit rows to the timeline: newest first, target tone, rejected = danger', () => {
    const ev = (event_type: string, created_at: string, payload: Record<string, unknown>): PlatformAuditEvent => ({
      event_type,
      created_at,
      actor_type: 'user',
      actor_id: 'op_7f3a91c2e48b',
      event_payload: payload,
    });
    const tl = timelineFrom([
      ev('tenant.provisioned', '2026-01-01T00:00:00Z', {}),
      ev('tenant.suspended', '2026-03-01T00:00:00Z', {
        before: { status: 'ACTIVE' },
        after: { status: 'SUSPENDED' },
        reason: { code: 'payment_overdue', text: 'Invoice unpaid' },
      }),
      ev('tenant.lifecycle_transition_rejected', '2026-02-01T00:00:00Z', {
        before: { status: 'ACTIVE' },
        after: { status: 'CLOSED' },
        reason: { code: 'illegal_transition', text: null },
      }),
    ]);
    expect(tl.map((e) => e.label)).toEqual(['Suspended', 'Transition rejected', 'Provisioned']);
    expect(tl[0]).toMatchObject({
      tone: 'warn',
      reason: { label: 'Payment overdue', code: 'payment_overdue' },
      note: 'Invoice unpaid',
      from: { label: 'Active' },
      to: { label: 'Suspended' },
    });
    expect(tl[1]?.tone).toBe('danger');
    expect(tl[2]?.tone).toBe('faint');
  });
});

describe('invite roles', () => {
  it('disables Owner and offers only tenant-assignable keys (no platform tier)', () => {
    expect(TENANT_INVITE_ROLES.find((r) => r.key === 'tenant_owner')?.disabled).toBe(true);
    expect(TENANT_INVITE_ROLES.some((r) => r.key === 'super_admin')).toBe(false);
    expect(TENANT_INVITE_ROLES.map((r) => r.key)).toContain('tenant_admin');
  });
});
