import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';

import {
  ALLOW_UNBOUND_HOST_ENV,
  HOST_BINDING_MODE_ENV,
  TENANT_ACCESS_DENIED_REASONS,
  allowUnboundHost,
  evaluateHostBinding,
  evaluateSessionHostBinding,
  REFRESH_ELIGIBILITY_REASONS,
  readHostBindingMode,
} from '../lib/host-binding.js';

// IC-2 PR-4 — the PURE host-binding policy (IC-0 §F.2 rule 1; Auth-Decoupling
// PR-4 Amendment A1 §2 item 5). Matrix of host class × consumer × resolved
// tenant → verdict, plus the fail-closed parse of the two env flags.

const T1 = '01900000-0000-7000-8000-0000000000aa';
const T2 = '01900000-0000-7000-8000-0000000000ab';

function verdict(over: Partial<Parameters<typeof evaluateHostBinding>[0]>) {
  return evaluateHostBinding({
    host_class: 'TENANT',
    context_id: T1,
    consumer: 'recruiter',
    resolved_context_id: T1,
    allow_unbound: false,
    ...over,
  });
}

describe('evaluateHostBinding — matrix', () => {
  it('TENANT: sealed context === resolved tenant → ok (bound)', () => {
    expect(verdict({})).toEqual({ ok: true, bound: true });
  });
  it('TENANT: sealed context ≠ resolved tenant → host_tenant_mismatch', () => {
    expect(verdict({ context_id: T2 })).toEqual({ ok: false, reason: 'host_tenant_mismatch' });
  });
  it('TENANT: no sealed context → host_tenant_mismatch (never bound by accident)', () => {
    expect(verdict({ context_id: null })).toEqual({ ok: false, reason: 'host_tenant_mismatch' });
    expect(verdict({ context_id: undefined })).toEqual({ ok: false, reason: 'host_tenant_mismatch' });
  });
  it('TENANT: a platform consumer resolving the sentinel on a tenant host → host_tenant_mismatch', () => {
    expect(verdict({ consumer: 'platform', resolved_context_id: PLATFORM_TENANT_SENTINEL_ID })).toEqual({
      ok: false,
      reason: 'host_tenant_mismatch',
    });
  });
  it('PLATFORM: platform consumer + sentinel (default sentinel id) → ok', () => {
    expect(
      verdict({ host_class: 'PLATFORM', context_id: null, consumer: 'platform', resolved_context_id: PLATFORM_TENANT_SENTINEL_ID }),
    ).toEqual({ ok: true, bound: true });
  });
  it('PLATFORM: platform consumer + explicit sentinel id override → ok', () => {
    expect(
      verdict({ host_class: 'PLATFORM', context_id: null, consumer: 'platform', resolved_context_id: 'x', platform_sentinel_id: 'x' }),
    ).toEqual({ ok: true, bound: true });
  });
  it('PLATFORM: non-platform consumer → host_class_consumer_mismatch', () => {
    expect(verdict({ host_class: 'PLATFORM', context_id: null })).toEqual({ ok: false, reason: 'host_class_consumer_mismatch' });
  });
  it('PLATFORM: platform consumer + non-sentinel tenant → host_tenant_mismatch', () => {
    expect(verdict({ host_class: 'PLATFORM', context_id: null, consumer: 'platform' })).toEqual({
      ok: false,
      reason: 'host_tenant_mismatch',
    });
  });
  it.each(['PORTAL', 'PRODUCT'] as const)('%s → host_class_consumer_mismatch regardless of consumer', (cls) => {
    expect(verdict({ host_class: cls })).toEqual({ ok: false, reason: 'host_class_consumer_mismatch' });
    expect(verdict({ host_class: cls, consumer: 'sign' })).toEqual({ ok: false, reason: 'host_class_consumer_mismatch' });
  });
  it.each([null, undefined, 'DEV'] as const)('unbound (%s): host_unbound unless allow_unbound', (cls) => {
    expect(verdict({ host_class: cls, context_id: null })).toEqual({ ok: false, reason: 'host_unbound' });
    expect(verdict({ host_class: cls, context_id: null, allow_unbound: true })).toEqual({ ok: true, bound: false });
  });
  it('allow_unbound never overrides an explicit mismatch', () => {
    expect(verdict({ context_id: T2, allow_unbound: true })).toEqual({ ok: false, reason: 'host_tenant_mismatch' });
    expect(verdict({ host_class: 'PLATFORM', context_id: null, allow_unbound: true })).toEqual({
      ok: false,
      reason: 'host_class_consumer_mismatch',
    });
  });
});

describe('flag parsing (fail-closed)', () => {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = { [HOST_BINDING_MODE_ENV]: process.env[HOST_BINDING_MODE_ENV], [ALLOW_UNBOUND_HOST_ENV]: process.env[ALLOW_UNBOUND_HOST_ENV] };
    delete process.env[HOST_BINDING_MODE_ENV];
    delete process.env[ALLOW_UNBOUND_HOST_ENV];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  it('mode defaults to log; only the exact literal "enforce" enforces', () => {
    expect(readHostBindingMode()).toBe('log');
    expect(readHostBindingMode({ [HOST_BINDING_MODE_ENV]: '' })).toBe('log');
    expect(readHostBindingMode({ [HOST_BINDING_MODE_ENV]: 'Enforce' })).toBe('log');
    expect(readHostBindingMode({ [HOST_BINDING_MODE_ENV]: 'strict' })).toBe('log');
    expect(readHostBindingMode({ [HOST_BINDING_MODE_ENV]: 'enforce' })).toBe('enforce');
    process.env[HOST_BINDING_MODE_ENV] = 'enforce';
    expect(readHostBindingMode()).toBe('enforce');
  });
  it('allow-unbound is only the exact literal "true"', () => {
    expect(allowUnboundHost()).toBe(false);
    expect(allowUnboundHost({ [ALLOW_UNBOUND_HOST_ENV]: 'TRUE' })).toBe(false);
    expect(allowUnboundHost({ [ALLOW_UNBOUND_HOST_ENV]: '1' })).toBe(false);
    expect(allowUnboundHost({ [ALLOW_UNBOUND_HOST_ENV]: 'true' })).toBe(true);
  });
  it('the 403 reason set is closed and complete', () => {
    expect([...TENANT_ACCESS_DENIED_REASONS].sort()).toEqual(
      ['host_class_consumer_mismatch', 'host_tenant_mismatch', 'host_unbound', 'no_active_tenant', 'tenant_resolution_ambiguous'],
    );
  });
});

// IC-2 PR-5 — the SESSION-SURFACE binding (/session, /refresh, /logout): PR-4
// rules unchanged for every Cognito consumer; ONE additive clause for `portal`.
describe('evaluateSessionHostBinding — session surface (PR-5)', () => {
  const base = { context_id: null, consumer: 'portal', resolved_context_id: PLATFORM_TENANT_SENTINEL_ID, allow_unbound: false } as const;
  it('portal consumer on the PORTAL host with the sentinel tenant → ok (bound)', () => {
    expect(evaluateSessionHostBinding({ ...base, host_class: 'PORTAL' })).toEqual({ ok: true, bound: true });
  });
  it('portal consumer on the PORTAL host with a NON-sentinel tenant → host_class_consumer_mismatch', () => {
    expect(evaluateSessionHostBinding({ ...base, host_class: 'PORTAL', resolved_context_id: T1 })).toEqual({
      ok: false,
      reason: 'host_class_consumer_mismatch',
    });
  });
  it.each(['TENANT', 'PLATFORM', 'PRODUCT'] as const)('portal consumer on a %s host → host_class_consumer_mismatch', (cls) => {
    expect(evaluateSessionHostBinding({ ...base, host_class: cls, context_id: T1 })).toEqual({
      ok: false,
      reason: 'host_class_consumer_mismatch',
    });
  });
  it.each([null, 'DEV'] as const)('portal consumer unbound (%s) → host_unbound unless allow_unbound', (cls) => {
    expect(evaluateSessionHostBinding({ ...base, host_class: cls })).toEqual({ ok: false, reason: 'host_unbound' });
    expect(evaluateSessionHostBinding({ ...base, host_class: cls, allow_unbound: true })).toEqual({ ok: true, bound: false });
  });
  it('non-portal consumers delegate to the PR-4 policy unchanged (TENANT match / mismatch / PORTAL refused)', () => {
    expect(evaluateSessionHostBinding({ host_class: 'TENANT', context_id: T1, consumer: 'recruiter', resolved_context_id: T1, allow_unbound: false })).toEqual({ ok: true, bound: true });
    expect(evaluateSessionHostBinding({ host_class: 'TENANT', context_id: T2, consumer: 'recruiter', resolved_context_id: T1, allow_unbound: false })).toEqual({ ok: false, reason: 'host_tenant_mismatch' });
    expect(evaluateSessionHostBinding({ host_class: 'PORTAL', context_id: null, consumer: 'recruiter', resolved_context_id: T1, allow_unbound: false })).toEqual({ ok: false, reason: 'host_class_consumer_mismatch' });
    expect(evaluateSessionHostBinding({ host_class: 'PLATFORM', context_id: null, consumer: 'platform', resolved_context_id: PLATFORM_TENANT_SENTINEL_ID, allow_unbound: false })).toEqual({ ok: true, bound: true });
  });
  it('the refresh eligibility reason set is closed and complete', () => {
    expect([...REFRESH_ELIGIBILITY_REASONS].sort()).toEqual(['consumer_not_entitled', 'consumer_not_supported', 'membership_inactive', 'tenant_closed', 'tenant_suspended', 'user_inactive']);
  });
});
