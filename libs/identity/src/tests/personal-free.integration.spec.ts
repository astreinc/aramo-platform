import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PersonalRiskService } from '../lib/personal/personal-risk.service.js';
import { PERSONAL_PROVISIONING_STALE_MS, PersonalSignupRepository } from '../lib/personal/personal-signup.repository.js';
import { DisabledSmsAdapter, LogSmsAdapter } from '../lib/personal/sms-verification.port.js';
import { IdentityProviderPolicyService } from '../lib/identity-provider-policy.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) — the identity-side
// Personal rows on REAL PostgreSQL 17 (the full identity migration set incl.
// 20261022120000_sign_personal_free): risk-state transitions audited in the same
// transaction; clear-review NEVER sets phone assurance; a restriction is never
// shortened; signup → provisioned risk state; invites; the review queue; the
// unbound 7-day lapse (and a bound owner never lapses); the signup-attempt
// cleanup; the pilot cap's reservation release; the Google pre-pin.

const ROOT = resolve(__dirname, '../../../..');
const splitDdl = (sql: string) => sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
const DAY = 24 * 60 * 60 * 1000;
const OPERATOR = '01900000-0000-7000-8000-00000000e0aa';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign Personal (Free) — identity rows (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  // `risk` = SMS configured (phone codes can be sent); `riskNoSms` = SMS unavailable
  // (the production default until a provider is approved).
  let risk: PersonalRiskService;
  let riskNoSms: PersonalRiskService;
  let signups: PersonalSignupRepository;
  let n = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    for (const p of resolveIdentityMigrations(ROOT)) {
      for (const stmt of splitDdl(readFileSync(p, 'utf8'))) if (stmt.trim().length > 0) await prisma.$executeRawUnsafe(stmt.trim());
    }
    risk = new PersonalRiskService(prisma, new LogSmsAdapter());
    riskNoSms = new PersonalRiskService(prisma, new DisabledSmsAdapter());
    signups = new PersonalSignupRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  const events = (tenant_id: string | null, event_type: string) => prisma.identityAuditEvent.findMany({ where: { tenant_id, event_type } });

  async function personalTenant(opts: { state?: string; step_up?: boolean; created_at?: Date } = {}): Promise<string> {
    n += 1;
    const id = uuidv7();
    await prisma.tenant.create({ data: { id, name: `Person ${n} (Personal)`, kind: 'PERSONAL' } });
    if (opts.state !== undefined) {
      await prisma.tenantRiskState.create({
        data: { tenant_id: id, state: opts.state, step_up_required: opts.step_up ?? false, ...(opts.created_at === undefined ? {} : { created_at: opts.created_at }) },
      });
    }
    return id;
  }
  const GEO = { country: 'US', looked_up_at: '2026-10-21T12:00:00.000Z', db_version: 'GeoLite2-Country 2026-10-20T00:00:00.000Z' };

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
      geo_evidence: GEO,
      risk_points: 0,
      risk_signals: [],
      decision: overrides.decision ?? 'allow',
      invite_id: null,
      status: 'PENDING',
      now: overrides.now ?? new Date(),
    });
  }

  async function signupInput(now: Date) {
    n += 1;
    const email = `person${n}@gmail.com`;
    return {
      email,
      canonical_email: email,
      display_name: `Person ${n}`,
      phone_e164: `+1202555${String(1000 + n).slice(-4)}`,
      declared_residence: 'US',
      ip: '203.0.113.7',
      ip_country: 'US',
      phone_region: 'US',
      network_kind: 'residential',
      geo_evidence: GEO,
      risk_points: 0,
      risk_signals: [],
      decision: 'allow' as const,
      invite_id: null,
      status: 'PENDING' as const,
      now,
    };
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
    expect((await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now: new Date() }))).toEqual({ ok: false, reason: 'phone_verification_required', location: 'inside' });
    expect(v.step_up_cleared_by).toBeNull();
    const ev = await events(t, 'identity.personal.risk.review_cleared');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_id: OPERATOR, actor_type: 'user', subject_id: t, event_payload: expect.objectContaining({ step_up_cleared: false }) });
    await expect(risk.clearReview(t, OPERATOR)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('SMS unavailable: clearing review lifts the phone step (step_up_cleared_by review, audited) — phone_verified_at stays NULL', async () => {
    const t = await personalTenant({ state: 'review', step_up: true, created_at: new Date(Date.now() - 30 * DAY) });
    const v = await riskNoSms.clearReview(t, OPERATOR, 'reviewed; SMS unavailable');
    expect(v).toMatchObject({ state: 'clear', step_up_required: false, step_up_cleared_by: 'review', phone_verified_at: null, decided_by: OPERATOR });
    expect(await riskNoSms.phoneVerified(t)).toBe(false);
    expect(await riskNoSms.assertPersonalSendAllowed(t, { ip_country: 'US', now: new Date() })).toEqual({ ok: true, location: 'inside' });
    const ev = await events(t, 'identity.personal.risk.review_cleared');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.event_payload).toMatchObject({ step_up_cleared: true, step_up_cleared_by: 'review', phone_verified: false, sms_available: false });
    // The column only ever holds 'review'.
    await expect(prisma.tenantRiskState.update({ where: { tenant_id: t }, data: { step_up_cleared_by: 'phone' } })).rejects.toThrow();
  });

  it('SMS unavailable: a send-time step-up routes the account to review (step_up_phone_unavailable)', async () => {
    const t = await personalTenant({ state: 'clear' });
    const v = await riskNoSms.requireStepUp(t, 'young_account_pdf_links');
    expect(v).toMatchObject({ state: 'review', step_up_required: true, reason: 'step_up_phone_unavailable', phone_verified_at: null });
    expect(await events(t, 'identity.personal.risk.step_up_required')).toHaveLength(1);
    const flagged = await events(t, 'identity.personal.risk.review_flagged');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.event_payload).toMatchObject({ reason: 'step_up_phone_unavailable', step_up_reason: 'young_account_pdf_links' });
  });

  it('send location: outside / UNKNOWN is allowed + audited with geo evidence on an established account; flagged for review on a young one', async () => {
    const now = new Date();
    const geoGB = { country: 'GB', looked_up_at: now.toISOString(), db_version: 'GeoLite2-Country 2026-10-20T00:00:00.000Z' };
    const established = await personalTenant({ state: 'clear', created_at: new Date(now.getTime() - 30 * DAY) });
    expect(await risk.assertPersonalSendAllowed(established, { ip_country: 'GB', now, geo: geoGB })).toEqual({ ok: true, location: 'outside' });
    expect(await risk.assertPersonalSendAllowed(established, { ip_country: null, now })).toEqual({ ok: true, location: 'unknown' });
    const sig = await prisma.identityAuditEvent.findMany({ where: { tenant_id: established, event_type: 'identity.personal.risk.send_location_signal' }, orderBy: { created_at: 'asc' } });
    expect(sig.map((e) => e.event_payload)).toEqual([
      expect.objectContaining({ location: 'outside', outcome: 'allowed', geo: geoGB }),
      expect.objectContaining({ location: 'unknown', outcome: 'allowed', geo: expect.objectContaining({ country: null, db_version: null }) }),
    ]);
    expect((await risk.riskStateOf(established))?.state).toBe('clear');
    // Inside: no location signal is written.
    await risk.assertPersonalSendAllowed(established, { ip_country: 'US', now });
    expect(await events(established, 'identity.personal.risk.send_location_signal')).toHaveLength(2);

    const young = await personalTenant({ state: 'clear' });
    expect(await risk.assertPersonalSendAllowed(young, { ip_country: 'GB', now, geo: geoGB })).toMatchObject({ ok: false, reason: 'personal_review_pending', flag_review: 'send_location_outside' });
    expect(await risk.riskStateOf(young)).toMatchObject({ state: 'review', reason: 'send_location_outside' });
    const flagged = await events(young, 'identity.personal.risk.review_flagged');
    expect(flagged[0]!.event_payload).toMatchObject({ reason: 'send_location_outside', geo: geoGB, location: 'outside' });
    expect((await events(young, 'identity.personal.risk.send_location_signal'))[0]!.event_payload).toMatchObject({ outcome: 'flagged_for_review', refusal: 'personal_review_pending', geo: geoGB });
  });

  it('only a phone code check sets phone assurance; it satisfies the step-up', async () => {
    const t = await personalTenant({ state: 'clear', step_up: true });
    await risk.markPhoneVerified(t, '+12025550111');
    expect(await risk.phoneVerified(t)).toBe(true);
    expect(await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now: new Date() })).toEqual({ ok: true, location: 'inside' });
    expect(await events(t, 'identity.personal.risk.phone_verified')).toHaveLength(1);
  });

  it('a temporary pause expires by itself; it never shortens a longer / indefinite restriction; reinstate is audited', async () => {
    const now = new Date();
    const t = await personalTenant({ state: 'clear' });
    await risk.restrict(t, 'abuse_reports', new Date(now.getTime() + 72 * 3600_000), null, now);
    expect(await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now })).toEqual({ ok: false, reason: 'personal_restricted' });
    expect(await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now: new Date(now.getTime() + 73 * 3600_000) })).toEqual({ ok: true, location: 'inside' });
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
    expect(await risk.assertPersonalSendAllowed(t, { ip_country: 'US', now: later })).toEqual({ ok: true, location: 'inside' });
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
    await signups.completeProvisioning({ id: row.id, tenant_id: t, owner_user_id: user, now, sms_available: false });
    expect(await risk.riskStateOf(t)).toMatchObject({ state: 'review', step_up_required: true, phone_verified_at: null, reason: 'step_up_phone_unavailable' });
    expect(await signups.findValidInvite(invite.code, email, now)).toBeNull();
    const prov = await events(t, 'identity.personal.signup.provisioned');
    expect(prov).toHaveLength(1);
    expect(prov[0]!.event_payload).toMatchObject({ reason: 'step_up_phone_unavailable', geo: { country: 'IN', looked_up_at: GEO.looked_up_at, db_version: GEO.db_version } });
    expect((await signups.reviewQueue()).find((i) => i.tenant_id === t)).toMatchObject({
      owner_email: email,
      state: 'review',
      decision: 'step_up',
      signals: [],
      step_up_cleared_by: null,
      geo: { country: 'IN', looked_up_at: GEO.looked_up_at, db_version: GEO.db_version },
    });
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
      geo_evidence: { ...GEO, country: 'IN' },
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

  it('attempt cleanup: abandoned attempts go 3 days after expiry, refused after 180 days, in one run (audited, counts only); bound, accepted, in-flight and invite-used rows are kept; idempotent', async () => {
    // A clock long before every other row in this database keeps the counts exact.
    const now = new Date('2020-01-10T12:00:00.000Z');
    const MIN = 60_000;
    const abandoned_cutoff = new Date(now.getTime() - 3 * DAY);
    const refused_cutoff = new Date(now.getTime() - 180 * DAY);
    // An attempt expires 24 h after it starts (PERSONAL_SIGNUP_TTL_MS).
    const startedToExpireAt = (expires: Date) => new Date(expires.getTime() - DAY);
    const over = startedToExpireAt(new Date(abandoned_cutoff.getTime() - MIN));
    const verified = async (at: Date) => {
      const r = await signupRow({ now: at });
      await signups.markEmailVerified(r.id, at);
      return r;
    };
    const refusedAt = async (at: Date) => signups.create({ ...(await signupInput(at)), status: 'REFUSED', decision: 'refuse' });

    // Rule (a) — deleted.
    const pendingOver = await signupRow({ now: over });
    const pendingAtCutoff = await signupRow({ now: startedToExpireAt(abandoned_cutoff) });
    const verifiedOver = await verified(over);
    const failedUnaccepted = await verified(over);
    await prisma.personalSignupRequest.update({ where: { id: failedUnaccepted.id }, data: { status: 'FAILED', failure_code: 'x' } });
    // Rule (a) — kept.
    const pendingUnder = await signupRow({ now: startedToExpireAt(new Date(abandoned_cutoff.getTime() + MIN)) });
    const failedAccepted = await verified(over);
    await signups.claimForProvisioning(failedAccepted.id, { documents: [], ip: null, at: over });
    await signups.markFailed(failedAccepted.id, 'provisioning_failed', over);
    const verifiedAccepted = await verified(over);
    await prisma.personalSignupRequest.update({ where: { id: verifiedAccepted.id }, data: { accepted_at: over } });
    const provisioning = await verified(over);
    await signups.claimForProvisioning(provisioning.id, { documents: [], ip: null, at: over });
    const bind = async (r: { id: string; email: string }) => {
      await signups.claimForProvisioning(r.id, { documents: [], ip: null, at: over });
      const t = await personalTenant();
      const user = uuidv7();
      await prisma.user.create({ data: { id: user, email: r.email, tenant_id: t } });
      await signups.completeProvisioning({ id: r.id, tenant_id: t, owner_user_id: user, now: over });
    };
    const provisioned = await verified(over);
    await bind(provisioned);
    const lapsed = await verified(over);
    await bind(lapsed);
    await prisma.personalSignupRequest.update({ where: { id: lapsed.id }, data: { status: 'LAPSED' } });
    const inviteUsed = await signupRow({ now: over });
    const inv = await signups.issueInvite(`invite${++n}@gmail.com`, OPERATOR, over);
    await prisma.personalSignupInvite.update({ where: { id: inv.id }, data: { used_at: over, used_by_signup_id: inviteUsed.id } });
    // Rule (b) — a refusal is evidence: kept at 179 days (and at 4 days, though long expired), deleted at 180 and 181.
    const refused179 = await refusedAt(new Date(now.getTime() - 179 * DAY));
    const refused4 = await refusedAt(new Date(now.getTime() - 4 * DAY));
    const refused180 = await refusedAt(refused_cutoff);
    const refused181 = await refusedAt(new Date(now.getTime() - 181 * DAY));

    const purged = () => prisma.identityAuditEvent.findMany({ where: { tenant_id: null, event_type: 'identity.personal.signup.attempts_purged' }, orderBy: { created_at: 'desc' } });
    const before = (await purged()).length;
    expect(await signups.purgeExpiredAttempts(now)).toEqual({ abandoned: 4, refused: 2, abandoned_cutoff, refused_cutoff });
    for (const gone of [pendingOver, pendingAtCutoff, verifiedOver, failedUnaccepted, refused180, refused181]) expect(await signups.findById(gone.id)).toBeNull();
    const kept = { pendingUnder, failedAccepted, verifiedAccepted, provisioning, provisioned, lapsed, inviteUsed, refused179, refused4 };
    for (const r of Object.values(kept)) expect(await signups.findById(r.id)).not.toBeNull();
    expect((await signups.findById(failedAccepted.id))?.status).toBe('FAILED');
    expect((await signups.findById(provisioning.id))?.status).toBe('PROVISIONING');
    expect((await signups.findById(provisioned.id))?.status).toBe('PROVISIONED');
    expect((await signups.findById(lapsed.id))?.status).toBe('LAPSED');

    const ev = await purged();
    expect(ev).toHaveLength(before + 1);
    expect(ev[0]).toMatchObject({
      actor_id: null,
      actor_type: 'system',
      event_payload: {
        abandoned: 4,
        refused: 2,
        abandoned_cutoff: abandoned_cutoff.toISOString(),
        refused_cutoff: refused_cutoff.toISOString(),
        abandoned_days: 3,
        refused_days: 180,
      },
    });
    // Counts only: no email, phone or address in the audit payload.
    expect(JSON.stringify(ev[0]!.event_payload)).not.toMatch(/@|\+1202|203\.0\.113/);

    // Idempotent: a re-run deletes nothing and writes no audit event.
    expect(await signups.purgeExpiredAttempts(now)).toEqual({ abandoned: 0, refused: 0, abandoned_cutoff, refused_cutoff });
    expect(await purged()).toHaveLength(before + 1);
    // Two minutes later only the attempt just under the boundary goes; nothing else moves.
    expect(await signups.purgeExpiredAttempts(new Date(now.getTime() + 2 * MIN))).toMatchObject({ abandoned: 1, refused: 0 });
    expect(await signups.findById(pendingUnder.id)).toBeNull();
    for (const r of Object.values(kept).filter((r) => r !== pendingUnder)) expect(await signups.findById(r.id)).not.toBeNull();

    // A daily run passes early_ms = its interval: everything that reaches its deadline
    // before the next run goes now (never later than promised); a refusal at 179 days
    // is within a day of 180, so it goes too; at 4 days it stays.
    const dueTomorrow = await signupRow({ now: startedToExpireAt(new Date(abandoned_cutoff.getTime() + 12 * 60 * MIN)) });
    expect(await signups.purgeExpiredAttempts(now)).toMatchObject({ abandoned: 0, refused: 0 });
    const daily = await signups.purgeExpiredAttempts(now, { early_ms: DAY });
    expect(daily).toMatchObject({ abandoned: 1, refused: 1, abandoned_cutoff: new Date(abandoned_cutoff.getTime() + DAY), refused_cutoff: new Date(refused_cutoff.getTime() + DAY) });
    expect(await signups.findById(dueTomorrow.id)).toBeNull();
    expect(await signups.findById(refused179.id)).toBeNull();
    expect(await signups.findById(refused4.id)).not.toBeNull();
  });

  // ── pilot cap (A1-8: atomic reservation with expiry / release) ─────────────
  describe('pilot cap', () => {
    // The open count every cap below is relative to (other tests leave rows behind).
    async function occupied(now: Date): Promise<number> {
      const live = await prisma.personalSignupRequest.count({
        where: { status: 'PROVISIONING', updated_at: { gt: new Date(now.getTime() - PERSONAL_PROVISIONING_STALE_MS) }, expires_at: { gt: now } },
      });
      return (await signups.activePersonalTenantCount()) + live;
    }
    const accepted = (at: Date) => ({ documents: [], ip: null, at });
    async function verifiedNow(now: Date) {
      const r = await signupRow({ now });
      await signups.markEmailVerified(r.id, now);
      return r;
    }
    async function provisionedTenant(now: Date): Promise<string> {
      const r = await verifiedNow(now);
      await signups.claimForProvisioning(r.id, accepted(now));
      const t = await personalTenant();
      const user = uuidv7();
      await prisma.user.create({ data: { id: user, email: r.email, tenant_id: t } });
      await signups.completeProvisioning({ id: r.id, tenant_id: t, owner_user_id: user, now });
      return t;
    }

    it('an account closed by its owner or an operator (risk state closed) frees its slot', async () => {
      const now = new Date();
      const t = await provisionedTenant(now);
      const cap = await occupied(now);
      const next = await verifiedNow(now);
      expect(await signups.claimForProvisioningWithinCap(next.id, accepted(now), cap)).toBe('full');
      await risk.close(t, OPERATOR, 'owner_closed', now, { closed_by: 'owner', note: null });
      expect((await prisma.tenant.findUnique({ where: { id: t } }))?.status).not.toBe('CLOSED');
      expect(await occupied(now)).toBe(cap - 1);
      expect(await signups.claimForProvisioningWithinCap(next.id, accepted(now), cap)).toBe('claimed');
      await signups.markFailed(next.id, 'test_release', now);
    });

    it('a stale reservation (PROVISIONING older than the stale window) frees its slot; a fresh one still blocks; an expired one frees it', async () => {
      const now = new Date();
      const held = await verifiedNow(now);
      expect(await signups.claimForProvisioningWithinCap(held.id, accepted(now), (await occupied(now)) + 1)).toBe('claimed');
      const cap = await occupied(now);
      const next = await verifiedNow(now);
      // Fresh (just under the stale window): blocks.
      await prisma.personalSignupRequest.update({ where: { id: held.id }, data: { updated_at: new Date(now.getTime() - PERSONAL_PROVISIONING_STALE_MS + 1000) } });
      expect(await signups.claimForProvisioningWithinCap(next.id, accepted(now), cap)).toBe('full');
      // Stale (at / past the window): released.
      await prisma.personalSignupRequest.update({ where: { id: held.id }, data: { updated_at: new Date(now.getTime() - PERSONAL_PROVISIONING_STALE_MS) } });
      expect(await signups.claimForProvisioningWithinCap(next.id, accepted(now), cap)).toBe('claimed');
      await signups.markFailed(next.id, 'test_release', now);
      // Fresh again but its attempt expired: released.
      await prisma.personalSignupRequest.update({ where: { id: held.id }, data: { updated_at: now, expires_at: now } });
      expect(await signups.claimForProvisioningWithinCap(next.id, accepted(now), cap)).toBe('claimed');
      await signups.markFailed(next.id, 'test_release', now);
      await signups.markFailed(held.id, 'test_release', now);
    });

    it('two concurrent claims at cap-1 still serialize: exactly one is claimed', async () => {
      const now = new Date();
      const a = await verifiedNow(now);
      const b = await verifiedNow(now);
      const cap = (await occupied(now)) + 1;
      const outcomes = (await Promise.all([a, b].map((r) => signups.claimForProvisioningWithinCap(r.id, accepted(now), cap)))).sort();
      expect(outcomes).toEqual(['claimed', 'full']);
      for (const r of [a, b]) await signups.markFailed(r.id, 'test_release', now);
    });
  });

  it('Google pre-pin: the enforced cohort is pinned to google before any sign-in', async () => {
    const t = await personalTenant();
    const idp = new IdentityProviderPolicyService(prisma);
    await idp.enrollEnforcedTenantPinned(t, 'google');
    await idp.enrollEnforcedTenantPinned(t, 'microsoft');
    expect(await idp.policyOf(t)).toEqual({ enforced: true, pin: 'google' });
  });
});
