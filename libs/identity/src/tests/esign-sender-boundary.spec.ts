import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';

import { ESIGN_SENDER_SCOPE_KEY } from '../lib/dto/role.dto.js';
import {
  EsignSenderBoundary,
  EsignSenderConsumerGuard,
  evaluateEsignSenderAuthorization,
} from '../lib/authorization/esign-sender-boundary.js';
import { filterScopesForConsumer } from '../lib/authorization/consumer-scope-policy.js';

// IC-3 PR-8 — the Sign SENDER authorization boundary, unit level: the pure
// decision (order of refusal) + the consumer guard + the composed decorator's
// metadata (what a `v1/sign/sender/*` route mounts). The real-PG / HTTP proof
// of the full guard chain is ic3-pr8-esign-sender-boundary.integration.spec.ts.

const SENDER_SCOPES = ['sign:envelope:create', 'sign:envelope:send', 'sign:envelope:read'];
const ORG_ADMIN_ONLY = ['tenant:admin:user-manage', 'tenant:admin:settings', 'audit:read', 'auth:session:read'];
const RECRUITER_SCOPES = ['talent:read', 'requisition:read', 'pipeline:add'];

describe('evaluateEsignSenderAuthorization — pure decision (fail closed, most specific reason first)', () => {
  const signTenant = new Set(['core', 'sign']);
  const atsTenant = new Set(['core', 'ats', 'portal']);
  const both = new Set(['core', 'ats', 'portal', 'sign']);

  it('#1 Sign-only tenant + esign consumer + sender scope → ok', () => {
    expect(evaluateEsignSenderAuthorization({ consumer: 'sign', tenantCapabilities: signTenant, scopes: SENDER_SCOPES })).toEqual({ ok: true });
  });
  it('#2 Sign-only tenant without the send scope (sign_viewer) → sender_scope_missing', () => {
    expect(evaluateEsignSenderAuthorization({ consumer: 'sign', tenantCapabilities: signTenant, scopes: ['sign:envelope:read'] })).toEqual({ ok: false, reason: 'sender_scope_missing' });
  });
  it('#3 org_admin alone (organization subset, no esign:*) → sender_scope_missing', () => {
    expect(evaluateEsignSenderAuthorization({ consumer: 'sign', tenantCapabilities: signTenant, scopes: ORG_ADMIN_ONLY })).toEqual({ ok: false, reason: 'sender_scope_missing' });
  });
  it('#4 ATS-only tenant → tenant_not_entitled, even when the principal holds a Sign role', () => {
    expect(evaluateEsignSenderAuthorization({ consumer: 'sign', tenantCapabilities: atsTenant, scopes: SENDER_SCOPES })).toEqual({ ok: false, reason: 'tenant_not_entitled' });
  });
  it('#5 recruiter consumer never sends — refused before any tenant/scope question (also: PR-6 strips esign:* from the ATS family)', () => {
    expect(evaluateEsignSenderAuthorization({ consumer: 'recruiter', tenantCapabilities: both, scopes: SENDER_SCOPES })).toEqual({ ok: false, reason: 'consumer_not_esign' });
    expect(filterScopesForConsumer({ consumer: 'recruiter', scopes: [...RECRUITER_SCOPES, ...SENDER_SCOPES], tenantHasEsign: true })).toEqual(RECRUITER_SCOPES);
  });
  it('#6 multi-product tenant: the esign consumer carries Sign scopes only, the recruiter consumer ATS scopes only — one identity, disjoint namespaces', () => {
    const union = [...RECRUITER_SCOPES, ...SENDER_SCOPES];
    const esignView = filterScopesForConsumer({ consumer: 'sign', scopes: union, tenantHasEsign: true });
    const recruiterView = filterScopesForConsumer({ consumer: 'recruiter', scopes: union, tenantHasEsign: true });
    expect(esignView).toEqual(SENDER_SCOPES);
    expect(recruiterView).toEqual(RECRUITER_SCOPES);
    expect(evaluateEsignSenderAuthorization({ consumer: 'sign', tenantCapabilities: both, scopes: esignView })).toEqual({ ok: true });
    expect(evaluateEsignSenderAuthorization({ consumer: 'recruiter', tenantCapabilities: both, scopes: recruiterView })).toEqual({ ok: false, reason: 'consumer_not_esign' });
  });
  it('#7 revoked Sign entitlement → tenant_not_entitled (the capability set is read live by the callers)', () => {
    const caps = new Set(['core', 'sign']);
    expect(evaluateEsignSenderAuthorization({ consumer: 'sign', tenantCapabilities: caps, scopes: SENDER_SCOPES }).ok).toBe(true);
    caps.delete('sign');
    expect(evaluateEsignSenderAuthorization({ consumer: 'sign', tenantCapabilities: caps, scopes: SENDER_SCOPES })).toEqual({ ok: false, reason: 'tenant_not_entitled' });
  });
  it('#10 platform (super_admin) consumer → consumer_not_esign; platform:* scopes never satisfy the send scope', () => {
    expect(evaluateEsignSenderAuthorization({ consumer: 'platform', tenantCapabilities: both, scopes: ['platform:tenant:provision'] })).toEqual({ ok: false, reason: 'consumer_not_esign' });
    expect(filterScopesForConsumer({ consumer: 'platform', scopes: [...SENDER_SCOPES, 'platform:tenant:provision'], tenantHasEsign: true })).toEqual(['platform:tenant:provision']);
  });
  it('unknown / portal / undefined consumers fail closed', () => {
    for (const consumer of ['portal', 'ingestion', 'bogus', undefined]) {
      expect(evaluateEsignSenderAuthorization({ consumer, tenantCapabilities: both, scopes: SENDER_SCOPES })).toEqual({ ok: false, reason: 'consumer_not_esign' });
    }
  });
});

function ctx(authContext: Record<string, unknown> | undefined): ExecutionContext {
  const request = { authContext, requestId: 'rq-pr8-guard' };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('EsignSenderConsumerGuard — layer 2 of the boundary', () => {
  const guard = new EsignSenderConsumerGuard();
  it('admits the esign consumer', () => {
    expect(guard.canActivate(ctx({ consumer_type: 'sign', tenant_id: 't', scopes: [] }))).toBe(true);
  });
  it.each(['recruiter', 'ingestion', 'platform', 'portal'])('refuses the %s consumer with 403 INSUFFICIENT_PERMISSIONS consumer_not_esign', (consumer_type) => {
    expect(() => guard.canActivate(ctx({ consumer_type, tenant_id: 't', scopes: [] }))).toThrowError(
      expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403, context: { requestId: 'rq-pr8-guard', details: { reason: 'consumer_not_esign', consumer_type } } }),
    );
  });
  it('fails closed without an auth context (JwtAuthGuard must run first)', () => {
    expect(() => guard.canActivate(ctx(undefined))).toThrowError(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 }));
  });
});

describe('@EsignSenderBoundary() — the composed metadata a sender route mounts', () => {
  class Probe {
    @EsignSenderBoundary()
    send(): string {
      return 'ok';
    }
  }
  const reflector = new Reflector();
  const handler = Probe.prototype.send;
  it('requires the esign capability AND the sign:envelope:send scope, through the four-guard chain in order', () => {
    expect(reflector.get<string[]>('aramo:entitlement:required_capabilities', handler)).toEqual(['sign']);
    expect(reflector.get<string[]>('aramo:authorization:required_scopes', handler)).toEqual([ESIGN_SENDER_SCOPE_KEY]);
    const guards = (reflector.get<unknown[]>('__guards__', handler) ?? []).map((g) => (g as { name: string }).name);
    expect(guards).toEqual(['JwtAuthGuard', 'EsignSenderConsumerGuard', 'EntitlementGuard', 'RolesGuard']);
  });
});
