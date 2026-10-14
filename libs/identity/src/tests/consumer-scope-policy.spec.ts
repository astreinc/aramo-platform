import { describe, expect, it } from 'vitest';

import {
  filterScopesForConsumer,
  requiredCapabilityForConsumer,
} from '../lib/authorization/consumer-scope-policy.js';

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
