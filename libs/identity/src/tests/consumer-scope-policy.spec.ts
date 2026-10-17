import { describe, expect, it } from 'vitest';

import {
  filterScopesForConsumer,
  requiredCapabilityForConsumer,
} from '../lib/authorization/consumer-scope-policy.js';
import { ORG_ADMIN_SCOPE_KEYS } from '../lib/dto/role.dto.js';

// IC-2 PR-6 — the pure consumer→capability (rule 3) and scope-namespace (rule 4)
// policy. One identity, independently entitled products.
const SCOPES = ['talent:read', 'tenant:admin:profile', 'esign:envelope:read', 'esign:envelope:send', 'platform:tenant:read', 'audit:read'];

describe('requiredCapabilityForConsumer (rule 3)', () => {
  it('recruiter and ingestion require ats; esign requires esign', () => {
    expect(requiredCapabilityForConsumer('recruiter')).toEqual({ kind: 'capability', capability: 'ats' });
    expect(requiredCapabilityForConsumer('ingestion')).toEqual({ kind: 'capability', capability: 'ats' });
    expect(requiredCapabilityForConsumer('esign')).toEqual({ kind: 'capability', capability: 'esign' });
  });
  it('platform is exempt (sentinel tenant has no entitlements)', () => {
    expect(requiredCapabilityForConsumer('platform')).toEqual({ kind: 'exempt' });
  });
  it.each(['portal', undefined, 'bogus', ''])('%s is unsupported on the Cognito mint path (fail closed)', (c) => {
    expect(requiredCapabilityForConsumer(c as string | undefined)).toEqual({ kind: 'unsupported' });
  });
});

describe('filterScopesForConsumer (rule 4)', () => {
  it('ATS family (recruiter, ingestion) never carries esign:* or platform:*', () => {
    for (const consumer of ['recruiter', 'ingestion']) {
      expect(filterScopesForConsumer({ consumer, scopes: SCOPES, tenantHasEsign: true })).toEqual([
        'talent:read', 'tenant:admin:profile', 'audit:read',
      ]);
    }
  });
  it('esign carries esign:* PLUS the product-neutral organization subset (ORG_ADMIN_SCOPE_KEYS), and ONLY while the tenant holds the esign capability', () => {
    expect(filterScopesForConsumer({ consumer: 'esign', scopes: SCOPES, tenantHasEsign: true })).toEqual([
      'tenant:admin:profile', 'esign:envelope:read', 'esign:envelope:send', 'audit:read',
    ]);
    // ATS product scopes never ride the esign consumer, even when the role holds them.
    expect(filterScopesForConsumer({ consumer: 'esign', scopes: ['talent:read', 'requisition:read', 'esign:envelope:read'], tenantHasEsign: true })).toEqual(['esign:envelope:read']);
    expect(filterScopesForConsumer({ consumer: 'esign', scopes: SCOPES, tenantHasEsign: false })).toEqual([]);
  });
  it('platform carries ONLY platform:* (never tenant product scopes)', () => {
    expect(filterScopesForConsumer({ consumer: 'platform', scopes: SCOPES, tenantHasEsign: true })).toEqual(['platform:tenant:read']);
  });
  it('portal and unknown consumers resolve nothing (fail closed)', () => {
    expect(filterScopesForConsumer({ consumer: 'portal', scopes: SCOPES, tenantHasEsign: true })).toEqual([]);
    expect(filterScopesForConsumer({ consumer: 'bogus', scopes: SCOPES, tenantHasEsign: true })).toEqual([]);
  });
  it('never widens: the output is always a subset of the input', () => {
    for (const consumer of ['recruiter', 'ingestion', 'esign', 'platform', 'portal', 'x']) {
      const out = filterScopesForConsumer({ consumer, scopes: SCOPES, tenantHasEsign: true });
      expect(out.every((s) => SCOPES.includes(s))).toBe(true);
    }
  });
});

// D-ORG (R2 / §3.C) — the SIXTH consumer `org`: the product-neutral organization
// credential. Rule 3: requires `core` (never ats/esign). Rule 4: carries EXACTLY
// ORG_ADMIN_SCOPE_KEYS ∩ held — never an ATS product scope, esign:* or platform:*.
describe('D-ORG — org consumer (rules 3 and 4)', () => {
  const HELD = ['auth:session:read', 'talent:read', 'requisition:create', 'esign:envelope:send', 'platform:tenant:provision', 'tenant:admin:user-manage', 'tenant:admin:profile', 'audit:read'];
  it('rule 3: org requires the core capability (and only core)', () => {
    expect(requiredCapabilityForConsumer('org')).toEqual({ kind: 'capability', capability: 'core' });
  });
  it('rule 4: org carries ONLY the organization subset the principal holds; entitlement to esign is irrelevant', () => {
    for (const tenantHasEsign of [true, false]) {
      const out = filterScopesForConsumer({ consumer: 'org', scopes: HELD, tenantHasEsign });
      expect(out.sort()).toEqual(['audit:read', 'auth:session:read', 'tenant:admin:profile', 'tenant:admin:user-manage']);
      expect(out.every((s) => (ORG_ADMIN_SCOPE_KEYS as readonly string[]).includes(s))).toBe(true);
      expect(out.some((s) => s.startsWith('esign:') || s.startsWith('platform:') || s === 'talent:read')).toBe(false);
    }
  });
  it('an ordinary member (no admin scope) resolves only its baseline marker on org — core ≠ org_admin', () => {
    expect(filterScopesForConsumer({ consumer: 'org', scopes: ['auth:session:read', 'talent:read', 'pipeline:add'], tenantHasEsign: false })).toEqual(['auth:session:read']);
  });
  it('the other consumers are unchanged by the addition (recruiter/esign/platform/portal/unknown)', () => {
    expect(filterScopesForConsumer({ consumer: 'recruiter', scopes: HELD, tenantHasEsign: true })).not.toContain('esign:envelope:send');
    expect(filterScopesForConsumer({ consumer: 'platform', scopes: HELD, tenantHasEsign: true })).toEqual(['platform:tenant:provision']);
    expect(filterScopesForConsumer({ consumer: 'portal', scopes: HELD, tenantHasEsign: true })).toEqual([]);
    expect(requiredCapabilityForConsumer('bogus')).toEqual({ kind: 'unsupported' });
  });
});
