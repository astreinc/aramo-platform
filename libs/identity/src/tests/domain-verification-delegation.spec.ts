import { beforeEach, describe, expect, it } from 'vitest';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import { REQUIRED_CAPABILITIES_KEY } from '@aramo/entitlement';
import type { MailerPort, SendEmailInput } from '@aramo/mailer';

import { filterScopesForConsumer } from '../lib/authorization/consumer-scope-policy.js';
import type { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import type { IdentityAuditRepository, WriteAuditEventInput } from '../lib/audit/identity-audit.repository.js';
import type { IdentityService } from '../lib/identity.service.js';
import type { TenantRepository, DomainVerificationRow } from '../lib/tenant.repository.js';
import { DelegateBudget, DELEGATE_BUDGET_MAX_PER_IP, DELEGATE_BUDGET_MAX_PER_TOKEN } from '../lib/domain-verification/delegate-budget.js';
import {
  DELEGATION_TTL_MS,
  buildDelegateLink,
  delegateLinkBase,
  generateDelegationToken,
  hashDelegationToken,
} from '../lib/domain-verification/delegation-token.js';
import type {
  DelegationRow,
  DomainVerificationDelegationRepository,
} from '../lib/domain-verification/domain-verification-delegation.repository.js';
import {
  DomainVerificationDelegationService,
  MAX_ACTIVE_DELEGATIONS,
  extractDelegateToken,
  normalizeDelegateEmail,
} from '../lib/domain-verification/domain-verification-delegation.service.js';
import { DomainVerificationController } from '../lib/domain-verification/domain-verification.controller.js';
import { DomainVerificationDelegateController } from '../lib/domain-verification/domain-verification-delegate.controller.js';
import type { DomainVerificationService } from '../lib/domain-verification/domain-verification.service.js';
import type { DomainVerificationView } from '../lib/domain-verification/domain-verification.view.js';

// Domain-Enforcement P3 (LOCKED) §5 — delegation of the P2b verification to an IT /
// domain administrator: token hashing, 7-day expiry, revoke, the narrow grant
// (only the record + the check for the delegating tenant), the constant 404, the
// rate limit, the email, and the tenant routes' guard metadata.

const TENANT = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const OTHER_TENANT = '22222222-0000-7000-8000-bbbbbbbbbbbb';
const OWNER = '00000000-0000-7000-8000-00000000aaa1';
const NOW = new Date('2026-10-21T12:00:00.000Z');

class FakeDelegations {
  rows: DelegationRow[] = [];
  async create(r: Omit<DelegationRow, 'revoked_at' | 'last_used_at'>): Promise<DelegationRow> {
    const row = { ...r, revoked_at: null, last_used_at: null };
    this.rows.push(row);
    return { ...row };
  }
  async listActive(t: string, now: Date) {
    return this.rows.filter((r) => r.tenant_id === t && r.revoked_at === null && r.expires_at > now);
  }
  async countActive(t: string, now: Date) {
    return (await this.listActive(t, now)).length;
  }
  async findForTenant(t: string, id: string) {
    return this.rows.find((r) => r.tenant_id === t && r.id === id) ?? null;
  }
  async revoke(t: string, id: string, now: Date) {
    const r = this.rows.find((x) => x.tenant_id === t && x.id === id && x.revoked_at === null);
    if (r === undefined) return false;
    r.revoked_at = now;
    return true;
  }
  async findByTokenHash(h: string) {
    return this.rows.find((r) => r.token_hash === h) ?? null;
  }
  async touch(id: string, now: Date) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.last_used_at = now;
  }
}

function dvRow(over: Partial<DomainVerificationRow> = {}): DomainVerificationRow {
  return {
    id: TENANT,
    allowed_domain: 'acme.corp',
    domain_verification_status: 'UNVERIFIED',
    domain_verification_token: null,
    domain_verified_at: null,
    domain_token_issued_at: null,
    ...over,
  };
}

function dvView(over: Partial<DomainVerificationView> = {}): DomainVerificationView {
  return {
    status: 'PENDING',
    allowed_domain: 'acme.corp',
    record_name: '_aramo-challenge.acme.corp',
    record_value: 'aramo-domain-verification=tok',
    verified_at: null,
    token_issued_at: NOW.toISOString(),
    domain_claim: 'PROVISIONAL',
    domain_claim_conflict: false,
    ...over,
  };
}

function setup(row: DomainVerificationRow = dvRow()) {
  const delegations = new FakeDelegations();
  const sent: SendEmailInput[] = [];
  const audits: { event_type: string; actor_id: string | null; subject_id: string; tenant_id: string | null; payload: Record<string, unknown> }[] = [];
  const calls: { ensure: string[]; check: string[] } = { ensure: [], check: [] };
  const verification = {
    ensureTokenForDelegate: async (t: string) => {
      calls.ensure.push(t);
      return { view: dvView(), issued: calls.ensure.length === 1, domain: 'acme.corp' };
    },
    checkVerification: async (t: string) => {
      calls.check.push(t);
      return { view: dvView({ status: 'VERIFIED', domain_claim: 'AUTHORITATIVE' }), verified: true, domain: 'acme.corp', claim_outcome: 'PROMOTED' as const };
    },
  };
  const tenants = { findDomainVerificationById: async (id: string) => (id === row.id ? row : null) };
  const identity = { getTenantLabel: async () => 'Acme <Corp>' };
  const audit = {
    writeEvent: async (e: { event_type: string; actor_id: string; subject_id: string; tenant_id: string; payload: Record<string, unknown> }) => {
      audits.push(e);
    },
  };
  const auditRepo = {
    writeEvent: async (e: WriteAuditEventInput) => {
      audits.push({ event_type: e.event_type, actor_id: e.actor_id, subject_id: e.subject_id, tenant_id: e.tenant_id, payload: e.event_payload });
      return { id: 'x' };
    },
  };
  const mailer: MailerPort = {
    send: async (m) => {
      sent.push(m);
      return { message_id: 'm' };
    },
  };
  const budget = new DelegateBudget();
  const svc = new DomainVerificationDelegationService(
    delegations as unknown as DomainVerificationDelegationRepository,
    tenants as unknown as TenantRepository,
    verification as unknown as DomainVerificationService,
    identity as unknown as IdentityService,
    audit as unknown as IdentityAuditService,
    auditRepo as unknown as IdentityAuditRepository,
    budget,
    mailer,
  );
  return { svc, delegations, sent, audits, calls, budget };
}

function rawFrom(sent: SendEmailInput[]): string {
  const m = /#token=([A-Za-z0-9_-]+)/.exec(sent[sent.length - 1]?.text ?? '');
  if (m === null) throw new Error('no token in email');
  return decodeURIComponent(m[1] as string);
}

describe('delegation token helpers', () => {
  it('a token is 256-bit base64url; only its SHA-256 (base64url) is stored', () => {
    const raw = generateDelegationToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const h = hashDelegationToken(raw);
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h).not.toBe(raw);
    expect(hashDelegationToken(raw)).toBe(h);
  });
  it('the link carries the token in the URL fragment of the Sign host page', () => {
    expect(buildDelegateLink('https://sign.aramo.ai/', 'abc')).toBe('https://sign.aramo.ai/domain-verification#token=abc');
    expect(delegateLinkBase({})).toBe('https://sign.aramo.ai');
    expect(delegateLinkBase({ ARAMO_SIGN_BASE_URL: 'https://sign.test/' })).toBe('https://sign.test');
  });
  it('email + token body parsing', () => {
    expect(normalizeDelegateEmail('  IT@Acme.Corp ')).toBe('it@acme.corp');
    expect(normalizeDelegateEmail('nope')).toBeNull();
    expect(normalizeDelegateEmail(42)).toBeNull();
    expect(extractDelegateToken({ token: 'x'.repeat(43) })).toBe('x'.repeat(43));
    expect(extractDelegateToken({ token: 'short' })).toBeNull();
    expect(extractDelegateToken(null)).toBeNull();
  });
});

describe('DomainVerificationDelegationService — issue / list / revoke', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('issue stores only the hash, expires in 7 days, emails the link, audits issued', async () => {
    const v = await s.svc.issue({ tenant_id: TENANT, actor_user_id: OWNER, delegate_email: 'IT@acme.corp', request_id: 'rq', now: NOW });
    expect(v.delegate_email).toBe('it@acme.corp');
    expect(new Date(v.expires_at).getTime() - NOW.getTime()).toBe(DELEGATION_TTL_MS);
    const row = s.delegations.rows[0] as DelegationRow;
    const raw = rawFrom(s.sent);
    expect(row.token_hash).toBe(hashDelegationToken(raw));
    expect(JSON.stringify(row)).not.toContain(raw);
    expect(s.sent[0]?.to).toBe('it@acme.corp');
    expect(s.sent[0]?.html).toContain('Acme &lt;Corp&gt;'); // escaped
    expect(s.sent[0]?.text).toContain('https://sign.aramo.ai/domain-verification#token=');
    const issued = s.audits.find((a) => a.event_type === 'identity.domain.verification.delegation.issued');
    expect(issued).toMatchObject({ actor_id: OWNER, subject_id: row.id, tenant_id: TENANT });
    expect(JSON.stringify(s.audits)).not.toContain(raw);
  });

  it('issue refuses an invalid email (400), a domain-less tenant (400) and a VERIFIED tenant (409 already_verified)', async () => {
    await expect(s.svc.issue({ tenant_id: TENANT, actor_user_id: OWNER, delegate_email: 'x', request_id: 'rq' })).rejects.toMatchObject({
      statusCode: 400,
    });
    const noDomain = setup(dvRow({ allowed_domain: null }));
    await expect(noDomain.svc.issue({ tenant_id: TENANT, actor_user_id: OWNER, delegate_email: 'it@acme.corp', request_id: 'rq' })).rejects.toMatchObject({
      statusCode: 400,
      context: { details: { reason: 'no_allowed_domain' } },
    });
    const verified = setup(dvRow({ domain_verification_status: 'VERIFIED' }));
    await expect(verified.svc.issue({ tenant_id: TENANT, actor_user_id: OWNER, delegate_email: 'it@acme.corp', request_id: 'rq' })).rejects.toMatchObject({
      statusCode: 409,
      context: { details: { reason: 'already_verified' } },
    });
    expect(verified.delegations.rows).toHaveLength(0);
  });

  it(`caps active links at ${MAX_ACTIVE_DELEGATIONS}`, async () => {
    for (let i = 0; i < MAX_ACTIVE_DELEGATIONS; i += 1) {
      await s.svc.issue({ tenant_id: TENANT, actor_user_id: OWNER, delegate_email: `it${i}@acme.corp`, request_id: 'rq', now: NOW });
    }
    await expect(s.svc.issue({ tenant_id: TENANT, actor_user_id: OWNER, delegate_email: 'more@acme.corp', request_id: 'rq', now: NOW })).rejects.toMatchObject({
      statusCode: 400,
      context: { details: { reason: 'too_many_active_delegations' } },
    });
  });

  it('list shows active only; revoke is tenant-scoped, idempotent and audited once', async () => {
    const v = await s.svc.issue({ tenant_id: TENANT, actor_user_id: OWNER, delegate_email: 'it@acme.corp', request_id: 'rq', now: NOW });
    expect((await s.svc.listActive(TENANT, NOW)).items.map((i) => i.id)).toEqual([v.id]);
    // Another tenant cannot see or revoke it.
    expect((await s.svc.listActive(OTHER_TENANT, NOW)).items).toEqual([]);
    await expect(s.svc.revoke({ tenant_id: OTHER_TENANT, actor_user_id: OWNER, id: v.id, request_id: 'rq' })).rejects.toMatchObject({ statusCode: 404 });
    const r = await s.svc.revoke({ tenant_id: TENANT, actor_user_id: OWNER, id: v.id, request_id: 'rq', now: NOW });
    expect(r.revoked_at).not.toBeNull();
    await s.svc.revoke({ tenant_id: TENANT, actor_user_id: OWNER, id: v.id, request_id: 'rq', now: NOW });
    expect(s.audits.filter((a) => a.event_type === 'identity.domain.verification.delegation.revoked')).toHaveLength(1);
    expect((await s.svc.listActive(TENANT, NOW)).items).toEqual([]);
  });

  it('expired links drop out of the active list', async () => {
    await s.svc.issue({ tenant_id: TENANT, actor_user_id: OWNER, delegate_email: 'it@acme.corp', request_id: 'rq', now: NOW });
    const later = new Date(NOW.getTime() + DELEGATION_TTL_MS + 1);
    expect((await s.svc.listActive(TENANT, later)).items).toEqual([]);
  });
});

describe('DomainVerificationDelegationService — the delegate (session-less) side', () => {
  let s: ReturnType<typeof setup>;
  let raw: string;
  beforeEach(async () => {
    s = setup();
    await s.svc.issue({ tenant_id: TENANT, actor_user_id: OWNER, delegate_email: 'it@acme.corp', request_id: 'rq', now: NOW });
    raw = rawFrom(s.sent);
  });

  it('view: the record for THAT tenant only; touches last_used_at; audits used (+ requested when the first token was minted)', async () => {
    const v = await s.svc.delegateView({ token: raw }, '1.1.1.1', 'rq', NOW);
    expect(v).toEqual({
      domain: 'acme.corp',
      record: { name: '_aramo-challenge.acme.corp', value: 'aramo-domain-verification=tok' },
      status: 'PENDING',
      domain_claim_conflict: false,
    });
    expect(s.calls.ensure).toEqual([TENANT]);
    expect(s.delegations.rows[0]?.last_used_at).toEqual(NOW);
    const used = s.audits.filter((a) => a.event_type === 'identity.domain.verification.delegation.used');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ actor_id: null, tenant_id: TENANT, payload: { action: 'view' } });
    expect(s.audits.some((a) => a.event_type === 'identity.domain.verification.requested')).toBe(true);
    // The delegate view exposes nothing beyond the four fields.
    expect(Object.keys(v).sort()).toEqual(['domain', 'domain_claim_conflict', 'record', 'status']);
  });

  it('check: runs the P2b check (+ promotion) for that tenant and audits verified + used', async () => {
    const v = await s.svc.delegateCheck({ token: raw }, '1.1.1.1', 'rq', NOW);
    expect(v.status).toBe('VERIFIED');
    expect(s.calls.check).toEqual([TENANT]);
    expect(s.audits.find((a) => a.event_type === 'identity.domain.verified')).toMatchObject({ tenant_id: TENANT, payload: { via: 'delegation' } });
    expect(s.audits.find((a) => a.event_type === 'identity.domain.verification.delegation.used' && a.payload['action'] === 'check')).toMatchObject({
      payload: { claim_outcome: 'PROMOTED' },
    });
  });

  it('unknown, malformed, expired and revoked tokens all give the same 404 and reach nothing', async () => {
    const bodies: unknown[] = [{ token: generateDelegationToken() }, { token: 'short' }, {}, null];
    for (const b of bodies) {
      await expect(s.svc.delegateView(b, '1.1.1.1', 'rq', NOW)).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    }
    const later = new Date(NOW.getTime() + DELEGATION_TTL_MS);
    await expect(s.svc.delegateCheck({ token: raw }, '1.1.1.2', 'rq', later)).rejects.toMatchObject({ statusCode: 404 });
    await s.svc.revoke({ tenant_id: TENANT, actor_user_id: OWNER, id: (s.delegations.rows[0] as DelegationRow).id, request_id: 'rq', now: NOW });
    await expect(s.svc.delegateCheck({ token: raw }, '1.1.1.3', 'rq', NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect(s.calls.ensure).toEqual([]);
    expect(s.calls.check).toEqual([]);
  });

  it('rate limit: per token and per IP, answered with the same 404', async () => {
    for (let i = 0; i < DELEGATE_BUDGET_MAX_PER_TOKEN; i += 1) {
      await s.svc.delegateView({ token: raw }, `10.0.0.${i}`, 'rq', NOW);
    }
    await expect(s.svc.delegateView({ token: raw }, '10.0.1.1', 'rq', NOW)).rejects.toMatchObject({ statusCode: 404 });
    s.budget.reset();
    for (let i = 0; i < DELEGATE_BUDGET_MAX_PER_IP; i += 1) {
      await s.svc.delegateView({ token: generateDelegationToken() }, '9.9.9.9', 'rq', NOW).catch(() => undefined);
    }
    s.budget.reset();
    // A fresh window lets the same token through again.
    await expect(s.svc.delegateView({ token: raw }, '9.9.9.9', 'rq', NOW)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('per-IP budget refuses before any lookup', async () => {
    for (let i = 0; i < DELEGATE_BUDGET_MAX_PER_IP; i += 1) {
      await s.svc.delegateView({ token: generateDelegationToken() }, '8.8.8.8', 'rq', NOW).catch(() => undefined);
    }
    await expect(s.svc.delegateView({ token: raw }, '8.8.8.8', 'rq', NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect(s.calls.ensure).toEqual([]);
  });
});

describe('guard metadata', () => {
  const proto = DomainVerificationController.prototype as unknown as Record<string, object>;

  it('tenant delegation routes sit on the guarded controller with tenant:admin:domain and capability core', () => {
    const guards = (Reflect.getMetadata('__guards__', DomainVerificationController) as { name: string }[]).map((g) => g.name);
    expect(guards).toEqual(['JwtAuthGuard', 'EntitlementGuard', 'RolesGuard']);
    expect(Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, DomainVerificationController)).toEqual(['core']);
    for (const h of ['listDelegations', 'issueDelegation', 'revokeDelegation', 'getStatus', 'requestVerification', 'checkVerification']) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, proto[h] as object)).toEqual(['tenant:admin:domain']);
    }
    expect(Reflect.getMetadata('path', proto['issueDelegation'] as object)).toBe('delegations');
    expect(Reflect.getMetadata('path', proto['revokeDelegation'] as object)).toBe('delegations/:id');
  });

  it('the delegate controller is session-less: no guards, no scopes, body-only token', () => {
    expect(Reflect.getMetadata('__guards__', DomainVerificationDelegateController)).toBeUndefined();
    expect(Reflect.getMetadata('path', DomainVerificationDelegateController)).toBe('v1/domain-verification/delegate');
    const dproto = DomainVerificationDelegateController.prototype as unknown as Record<string, object>;
    for (const h of ['view', 'check']) {
      expect(Reflect.getMetadata('__guards__', dproto[h] as object)).toBeUndefined();
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, dproto[h] as object)).toBeUndefined();
      expect(Reflect.getMetadata('method', dproto[h] as object)).toBe(1); // RequestMethod.POST
    }
  });
});

describe('the Sign workspace session can reach the tenant domain routes (P3 §4)', () => {
  it('a sign-consumer session keeps tenant:admin:domain while the tenant holds the sign capability', () => {
    const scopes = ['tenant:admin:domain', 'sign:envelope:read', 'requisition:read'];
    expect(filterScopesForConsumer({ consumer: 'sign', scopes, tenantHasEsign: true })).toContain('tenant:admin:domain');
    expect(filterScopesForConsumer({ consumer: 'sign', scopes, tenantHasEsign: true })).not.toContain('requisition:read');
    expect(filterScopesForConsumer({ consumer: 'org', scopes, tenantHasEsign: false })).toContain('tenant:admin:domain');
  });
});
