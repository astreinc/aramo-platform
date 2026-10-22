import { describe, expect, it } from 'vitest';

import {
  filterScopesForConsumer,
  requiredCapabilityForConsumer,
} from '../lib/authorization/consumer-scope-policy.js';
import { ORG_ADMIN_SCOPE_KEYS } from '../lib/dto/role.dto.js';

// IC-2 PR-6 — the pure consumer→capability (rule 3) and scope-namespace (rule 4)
// policy. One identity, independently entitled products.
const SCOPES = ['talent:read', 'tenant:admin:profile', 'sign:envelope:read', 'sign:envelope:send', 'platform:tenant:read', 'audit:read'];

describe('requiredCapabilityForConsumer (rule 3)', () => {
  it('recruiter and ingestion require ats; esign requires esign', () => {
    expect(requiredCapabilityForConsumer('recruiter')).toEqual({ kind: 'capability', capability: 'ats' });
    expect(requiredCapabilityForConsumer('ingestion')).toEqual({ kind: 'capability', capability: 'ats' });
    expect(requiredCapabilityForConsumer('sign')).toEqual({ kind: 'capability', capability: 'sign' });
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
    expect(filterScopesForConsumer({ consumer: 'sign', scopes: SCOPES, tenantHasEsign: true })).toEqual([
      'tenant:admin:profile', 'sign:envelope:read', 'sign:envelope:send', 'audit:read',
    ]);
    // ATS product scopes never ride the esign consumer, even when the role holds them.
    expect(filterScopesForConsumer({ consumer: 'sign', scopes: ['talent:read', 'requisition:read', 'sign:envelope:read'], tenantHasEsign: true })).toEqual(['sign:envelope:read']);
    expect(filterScopesForConsumer({ consumer: 'sign', scopes: SCOPES, tenantHasEsign: false })).toEqual([]);
  });
  it('platform carries ONLY platform:* (never tenant product scopes)', () => {
    expect(filterScopesForConsumer({ consumer: 'platform', scopes: SCOPES, tenantHasEsign: true })).toEqual(['platform:tenant:read']);
  });
  it('portal and unknown consumers resolve nothing (fail closed)', () => {
    expect(filterScopesForConsumer({ consumer: 'portal', scopes: SCOPES, tenantHasEsign: true })).toEqual([]);
    expect(filterScopesForConsumer({ consumer: 'bogus', scopes: SCOPES, tenantHasEsign: true })).toEqual([]);
  });
  it('never widens: the output is always a subset of the input', () => {
    for (const consumer of ['recruiter', 'ingestion', 'sign', 'platform', 'portal', 'x']) {
      const out = filterScopesForConsumer({ consumer, scopes: SCOPES, tenantHasEsign: true });
      expect(out.every((s) => SCOPES.includes(s))).toBe(true);
    }
  });
});

// D-ORG (R2 / §3.C) — the SIXTH consumer `org`: the product-neutral organization
// credential. Rule 3: requires `core` (never ats/esign). Rule 4: carries EXACTLY
// ORG_ADMIN_SCOPE_KEYS ∩ held — never an ATS product scope, esign:* or platform:*.
describe('D-ORG — org consumer (rules 3 and 4)', () => {
  const HELD = ['auth:session:read', 'talent:read', 'requisition:create', 'sign:envelope:send', 'platform:tenant:provision', 'tenant:admin:user-manage', 'tenant:admin:profile', 'audit:read'];
  it('rule 3: org requires the core capability (and only core)', () => {
    expect(requiredCapabilityForConsumer('org')).toEqual({ kind: 'capability', capability: 'core' });
  });
  it('rule 4: org carries ONLY the organization subset the principal holds; entitlement to esign is irrelevant', () => {
    for (const tenantHasEsign of [true, false]) {
      const out = filterScopesForConsumer({ consumer: 'org', scopes: HELD, tenantHasEsign });
      expect(out.sort()).toEqual(['audit:read', 'auth:session:read', 'tenant:admin:profile', 'tenant:admin:user-manage']);
      expect(out.every((s) => (ORG_ADMIN_SCOPE_KEYS as readonly string[]).includes(s))).toBe(true);
      expect(out.some((s) => s.startsWith('sign:') || s.startsWith('platform:') || s === 'talent:read')).toBe(false);
    }
  });
  it('an ordinary member (no admin scope) resolves only its baseline marker on org — core ≠ org_admin', () => {
    expect(filterScopesForConsumer({ consumer: 'org', scopes: ['auth:session:read', 'talent:read', 'pipeline:add'], tenantHasEsign: false })).toEqual(['auth:session:read']);
  });
  it('the other consumers are unchanged by the addition (recruiter/esign/platform/portal/unknown)', () => {
    expect(filterScopesForConsumer({ consumer: 'recruiter', scopes: HELD, tenantHasEsign: true })).not.toContain('sign:envelope:send');
    expect(filterScopesForConsumer({ consumer: 'platform', scopes: HELD, tenantHasEsign: true })).toEqual(['platform:tenant:provision']);
    expect(filterScopesForConsumer({ consumer: 'portal', scopes: HELD, tenantHasEsign: true })).toEqual([]);
    expect(requiredCapabilityForConsumer('bogus')).toEqual({ kind: 'unsupported' });
  });
});

// DOC-TEMPLATE-LIB-1 T-4 (Directive v1.0 LOCKED §6.2; conforming amendment row 8) — the
// org credential additionally carries document_template:{read,manage}; the sign credential
// additionally carries document_template:read (never :manage); the ATS family is unchanged.
describe('DOC-TEMPLATE-LIB-1 T-4 — document_template:* on the org and sign sessions', () => {
  const HELD = [
    'auth:session:read',
    'tenant:admin:profile',
    'document_template:read',
    'document_template:manage',
    'document_requirement:read',
    'talent:read',
    'sign:envelope:send',
    'platform:document_template:manage',
  ];
  it('org = the organization subset + document_template:author/:manage (+ :read alongside them) (held only)', () => {
    for (const tenantHasEsign of [true, false]) {
      expect(filterScopesForConsumer({ consumer: 'org', scopes: HELD, tenantHasEsign }).sort()).toEqual([
        'auth:session:read',
        'document_template:manage',
        'document_template:read',
        'tenant:admin:profile',
      ]);
    }
    // ORG-UX-1 §4.1 (amendment row 9) — read ALONE never rides the org session: a recruiter's
    // read-for-sending does not open the Org template pages.
    expect(
      filterScopesForConsumer({ consumer: 'org', scopes: ['auth:session:read', 'document_template:read', 'talent:read'], tenantHasEsign: false }),
    ).toEqual(['auth:session:read']);
    // An author carries author + read (the template list/get reads).
    expect(
      filterScopesForConsumer({ consumer: 'org', scopes: ['auth:session:read', 'document_template:read', 'document_template:author'], tenantHasEsign: false }).sort(),
    ).toEqual(['auth:session:read', 'document_template:author', 'document_template:read']);
  });
  it('sign = sign:* + the organization subset + document_template:read — never :manage, never other Documents scopes', () => {
    expect(filterScopesForConsumer({ consumer: 'sign', scopes: HELD, tenantHasEsign: true }).sort()).toEqual([
      'auth:session:read',
      'document_template:read',
      'sign:envelope:send',
      'tenant:admin:profile',
    ]);
    expect(filterScopesForConsumer({ consumer: 'sign', scopes: HELD, tenantHasEsign: false })).toEqual([]);
  });
  it('the platform credential never carries the tenant-tier template scopes (and vice versa)', () => {
    expect(filterScopesForConsumer({ consumer: 'platform', scopes: HELD, tenantHasEsign: true })).toEqual([
      'platform:document_template:manage',
    ]);
    for (const consumer of ['org', 'sign']) {
      expect(filterScopesForConsumer({ consumer, scopes: HELD, tenantHasEsign: true })).not.toContain(
        'platform:document_template:manage',
      );
    }
  });
  it('the ATS family keeps document_template:* exactly as before (held ⇒ carried)', () => {
    expect(filterScopesForConsumer({ consumer: 'recruiter', scopes: HELD, tenantHasEsign: true })).toEqual([
      'auth:session:read',
      'tenant:admin:profile',
      'document_template:read',
      'document_template:manage',
      'document_requirement:read',
      'talent:read',
    ]);
  });
});
