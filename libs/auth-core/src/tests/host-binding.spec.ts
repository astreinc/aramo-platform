import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';

import {
  ALLOW_UNBOUND_HOST_ENV,
  HOST_BINDING_MODE_ENV,
  TENANT_ACCESS_DENIED_REASONS,
  allowUnboundHost,
  evaluateHostBinding,
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
    expect(verdict({ host_class: cls, consumer: 'esign' })).toEqual({ ok: false, reason: 'host_class_consumer_mismatch' });
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
