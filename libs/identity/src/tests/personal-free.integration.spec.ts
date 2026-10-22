import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PersonalRiskService } from '../lib/personal/personal-risk.service.js';
import { PersonalSignupRepository } from '../lib/personal/personal-signup.repository.js';
import { IdentityProviderPolicyService } from '../lib/identity-provider-policy.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) — the identity-side
// Personal rows on REAL PostgreSQL 17 (the full identity migration set incl.
// 20261022120000_sign_personal_free): risk-state transitions audited in the same
// transaction; clear-review NEVER sets phone assurance; a restriction is never
// shortened; signup → provisioned risk state; invites; the review queue; the
// unbound 7-day lapse (and a bound owner never lapses); the Google pre-pin.

const ROOT = resolve(__dirname, '../../../..');
const splitDdl = (sql: string) => sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
const DAY = 24 * 60 * 60 * 1000;
const OPERATOR = '01900000-0000-7000-8000-00000000e0aa';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign Personal (Free) — identity rows (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let risk: PersonalRiskService;
  let signups: PersonalSignupRepository;
  let n = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    for (const p of resolveIdentityMigrations(ROOT)) {
      for (const stmt of splitDdl(readFileSync(p, 'utf8'))) if (stmt.trim().length > 0) await prisma.$executeRawUnsafe(stmt.trim());
    }
    risk = new PersonalRiskService(prisma);
    signups = new PersonalSignupRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  const events = (tenant_id: string | null, event_type: string) => prisma.identityAuditEvent.findMany({ where: { tenant_id, event_type } });

  async function personalTenant(opts: { state?: string; step_up?: boolean } = {}): Promise<string> {
    n += 1;
    const id = uuidv7();
    await prisma.tenant.create({ data: { id, name: `Person ${n} (Personal)`, kind: 'PERSONAL' } });
    if (opts.state !== undefined) {
      await prisma.tenantRiskState.create({ data: { tenant_id: id, state: opts.state, step_up_required: opts.step_up ?? false } });
    }
    return id;
  }

  async function signupRow(overrides: { email?: string; phone?: string; decision?: 'allow' | 'step_up' | 'review'; ip?: string; now?: Date } = {}) {
    n += 1;
    const email = overrides.email ?? `person${n}@gmail.com`;
    return signups.create({
      email,
      canonical_email: email,
      display_name: `Person ${n}`,
      phone_e164: overrides.phone ?? `+1202555${String(1000 + n).slice(-4)}`,
      declared_residence: 'US',
      ip: overrides.ip ?? '203.0.113.7',
      ip_country: 'US',
      phone_region: 'US',
      network_kind: 'residential',
      risk_points: 0,
      risk_signals: [],
      decision: overrides.decision ?? 'allow',
      invite_id: null,
      status: 'PENDING',
      now: overrides.now ?? new Date(),
    });
  }

  it('the migration created the three tables with their CHECKs', async () => {
    const t = await personalTenant();
    await expect(prisma.tenantRiskState.create({ data: { tenant_id: t, state: 'nonsense' } })).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO "identity"."PersonalSignupRequest" (id, email, canonical_email, display_name, phone_e164, declared_residence, decision, expires_at) VALUES ('${uuidv7()}', 'a@gmail.com', 'a@gmail.com', 'A', '+12025550100', 'US', 'maybe', now())`),
    ).rejects.toThrow();
  });

  it('review → clear (approve) is audited and NEVER sets phone_verified_at', async () => {
    const t = await personalTenant({ state: 'review', step_up: true });
    const v = await risk.clearReview(t, OPERATOR, 'looks fine');
    expect(v).toMatchObject({ state: 'clear', step_up_required: true, phone_verified_at: null, decided_by: OPERATOR });
    expect(await risk.phoneVerified(t)).toBe(false);
    expect((await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now: new Date() }))).toEqual({ ok: false, reason: 'phone_verification_required' });
    const ev = await events(t, 'identity.personal.risk.review_cleared');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_id: OPERATOR, actor_type: 'user', subject_id: t });
    await expect(risk.clearReview(t, OPERATOR)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('only a phone code check sets phone assurance; it satisfies the step-up', async () => {
    const t = await personalTenant({ state: 'clear', step_up: true });
    await risk.markPhoneVerified(t, '+12025550111');
    expect(await risk.phoneVerified(t)).toBe(true);
    expect(await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now: new Date() })).toEqual({ ok: true });
    expect(await events(t, 'identity.personal.risk.phone_verified')).toHaveLength(1);
  });

  it('a temporary pause expires by itself; it never shortens a longer / indefinite restriction; reinstate is audited', async () => {
    const now = new Date();
    const t = await personalTenant({ state: 'clear' });
    await risk.restrict(t, 'abuse_reports', new Date(now.getTime() + 72 * 3600_000), null, now);
    expect(await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now })).toEqual({ ok: false, reason: 'personal_restricted' });
    expect(await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now: new Date(now.getTime() + 73 * 3600_000) })).toEqual({ ok: true });
    // Operator confirms (indefinite); a later automatic pause does not shorten it.
    await risk.restrict(t, 'confirmed', null, OPERATOR, now);
    const after = await risk.restrict(t, 'abuse_reports', new Date(now.getTime() + 3600_000), null, now);
    expect(after.restricted_until).toBeNull();
    expect(await events(t, 'identity.personal.risk.restricted')).toHaveLength(3);
    const back = await risk.reinstate(t, OPERATOR, 'appeal upheld');
    expect(back).toMatchObject({ state: 'clear', restricted_until: null });
    expect(await events(t, 'identity.personal.risk.reinstated')).toHaveLength(1);
  });

  it('a temporary pause over a pending review never erases the review; clearing the review keeps the pause', async () => {
    const now = new Date();
    const t = await personalTenant({ state: 'review' });
    const r = await risk.restrict(t, 'abuse_reports', new Date(now.getTime() + 72 * 3600_000), null, now);
    expect(r).toMatchObject({ state: 'restricted', review_pending: true });
    const later = new Date(now.getTime() + 73 * 3600_000);
    expect(await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now: later })).toEqual({ ok: false, reason: 'personal_review_pending' });
    // A review flagged during a pause is recorded as owed, not dropped.
    const t2 = await personalTenant({ state: 'clear' });
    await risk.restrict(t2, 'abuse_reports', new Date(now.getTime() + 3600_000), null, now);
    expect(await risk.flagForReview(t2, 'impersonation_wording')).toMatchObject({ state: 'restricted', review_pending: true });
    // Clearing the owed review keeps the restriction; once it lapses, sending resumes.
    const cleared = await risk.clearReview(t, OPERATOR, 'reviewed');
    expect(cleared).toMatchObject({ state: 'restricted', review_pending: false });
    expect(cleared.phone_verified_at).toBeNull();
    expect(await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now: later })).toEqual({ ok: true });
  });

  it('close is final for sends; restrict leaves a closed account closed', async () => {
    const t = await personalTenant({ state: 'review' });
    await risk.close(t, OPERATOR, 'fraud');
    expect((await risk.restrict(t, 'abuse_reports', null)).state).toBe('closed');
    expect(await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now: new Date() })).toEqual({ ok: false, reason: 'personal_restricted' });
    await expect(risk.reinstate(t, OPERATOR)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('young-account checks: step-up and review flags are idempotent and audited', async () => {
    const t = await personalTenant({ state: 'clear' });
    await risk.requireStepUp(t, 'first_send_many_recipients');
    await risk.requireStepUp(t, 'again');
    expect(await events(t, 'identity.personal.risk.step_up_required')).toHaveLength(1);
    await risk.flagForReview(t, 'lure_wording');
    await risk.flagForReview(t, 'again');
    expect((await risk.riskStateOf(t))?.state).toBe('review');
    expect(await events(t, 'identity.personal.risk.review_flagged')).toHaveLength(1);
    const none = await personalTenant();
    await expect(risk.requireStepUp(none, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await risk.assertPersonalSendAllowed(none, { ip_country: 'US', now: new Date() })).toEqual({ ok: false, reason: 'personal_review_pending' });
  });

  it('completeProvisioning opens the risk state from the decision, consumes the invite and audits — all at once', async () => {
    const now = new Date();
    const email = `invited${++n}@gmail.com`;
    const invite = await signups.issueInvite(email, OPERATOR, now);
    expect(invite.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(await events(null, 'identity.personal.invite.issued')).toEqual(expect.arrayContaining([expect.objectContaining({ subject_id: invite.id, actor_id: OPERATOR })]));
    expect(JSON.stringify(await prisma.personalSignupInvite.findUnique({ where: { id: invite.id } }))).not.toContain(invite.code);
    expect(await signups.findValidInvite(invite.code, email, now)).toEqual({ id: invite.id });
    expect(await signups.findValidInvite(invite.code, 'other@gmail.com', now)).toBeNull();
    expect(await signups.findValidInvite(invite.code, email, new Date(now.getTime() + 8 * DAY))).toBeNull();

    const row = await signups.create({ ...(await baseFor(email)), decision: 'step_up', invite_id: invite.id, status: 'PENDING', now });
    await signups.markEmailVerified(row.id, now);
    expect(await signups.claimForProvisioning(row.id, { documents: [], ip: '203.0.113.7', at: now })).toBe(true);
    expect(await signups.claimForProvisioning(row.id, { documents: [], ip: '203.0.113.7', at: now })).toBe(false);
    const t = await personalTenant();
    const user = uuidv7();
    await prisma.user.create({ data: { id: user, email, tenant_id: t } });
    await signups.completeProvisioning({ id: row.id, tenant_id: t, owner_user_id: user, now });
    expect(await risk.riskStateOf(t)).toMatchObject({ state: 'review', step_up_required: true, phone_verified_at: null });
    expect(await signups.findValidInvite(invite.code, email, now)).toBeNull();
    expect(await events(t, 'identity.personal.signup.provisioned')).toHaveLength(1);
    expect((await signups.reviewQueue()).find((i) => i.tenant_id === t)).toMatchObject({ owner_email: email, state: 'review', decision: 'step_up', signals: [] });
    expect(await signups.activePersonalTenantCount()).toBeGreaterThanOrEqual(1);
  });

  async function baseFor(email: string) {
    return {
      email,
      canonical_email: email,
      display_name: 'Invited Person',
      phone_e164: '+919876543210',
      declared_residence: 'IN',
      ip: '198.51.100.4',
      ip_country: 'IN',
      phone_region: 'IN',
      network_kind: 'residential',
      risk_points: 30,
      risk_signals: [],
    };
  }

  it('duplicate signals: Gmail alias of an existing User; phone held by another account; per-IP count', async () => {
    const t = await personalTenant({ state: 'clear' });
    await prisma.user.create({ data: { id: uuidv7(), email: 'jane.doe+old@gmail.com', tenant_id: t } });
    expect(await signups.gmailAliasOfExisting('janedoe@gmail.com', 'janedoe@gmail.com')).toBe(true);
    expect(await signups.gmailAliasOfExisting('nobody@gmail.com', 'nobody@gmail.com')).toBe(false);
    await prisma.tenantRiskState.update({ where: { tenant_id: t }, data: { phone_e164: '+12025550999' } });
    expect(await signups.phoneUsedByAnother('+12025550999', 'x@gmail.com')).toBe(true);
    expect(await signups.phoneUsedByAnother('+12025550998', 'x@gmail.com')).toBe(false);
    const ip = '192.0.2.200';
    await signupRow({ ip });
    await signupRow({ ip });
    expect(await signups.countByIpSince(ip, new Date(Date.now() - DAY))).toBe(2);
  });

  it('the 7-day unbound lapse soft-disables the tenant (audited); a bound owner or a fresh signup never lapses', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 8 * DAY);
    const make = async (provisioned_at: Date) => {
      const row = await signupRow({ now: provisioned_at });
      await signups.markEmailVerified(row.id, provisioned_at);
      await signups.claimForProvisioning(row.id, { documents: [], ip: null, at: provisioned_at });
      const t = await personalTenant();
      const user = uuidv7();
      await prisma.user.create({ data: { id: user, email: row.email, tenant_id: t } });
      await signups.completeProvisioning({ id: row.id, tenant_id: t, owner_user_id: user, now: provisioned_at });
      return { row, t, user };
    };
    const unbound = await make(old);
    const bound = await make(old);
    await prisma.externalIdentity.create({ data: { id: uuidv7(), provider: 'cognito', provider_subject: `sub-${uuidv7()}`, user_id: bound.user } });
    const fresh = await make(new Date(now.getTime() - 2 * DAY));

    expect(await signups.lapseUnbound(now)).toBe(1);
    expect(await signups.lapseUnbound(now)).toBe(0);
    expect((await prisma.tenant.findUnique({ where: { id: unbound.t } }))?.is_active).toBe(false);
    expect((await signups.findById(unbound.row.id))?.status).toBe('LAPSED');
    expect(await events(unbound.t, 'identity.personal.signup.lapsed')).toHaveLength(1);
    for (const kept of [bound, fresh]) {
      expect((await prisma.tenant.findUnique({ where: { id: kept.t } }))?.is_active).toBe(true);
      expect((await signups.findById(kept.row.id))?.status).toBe('PROVISIONED');
    }
  });

  it('Google pre-pin: the enforced cohort is pinned to google before any sign-in', async () => {
    const t = await personalTenant();
    const idp = new IdentityProviderPolicyService(prisma);
    await idp.enrollEnforcedTenantPinned(t, 'google');
    await idp.enrollEnforcedTenantPinned(t, 'microsoft');
    expect(await idp.policyOf(t)).toEqual({ enforced: true, pin: 'google' });
  });
});
