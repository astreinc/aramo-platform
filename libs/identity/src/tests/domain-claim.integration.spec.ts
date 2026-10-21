import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, createAramoLogger, resolveIdentityMigrations } from '@aramo/common';

import { IdentityAuditRepository } from '../lib/audit/identity-audit.repository.js';
import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { DOMAIN_CLAIM_PROVISIONAL_DAYS, DomainClaimService } from '../lib/domain-claim/domain-claim.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TenantRepository } from '../lib/tenant.repository.js';
import { TenantService } from '../lib/tenant.service.js';
import { ASTRE_ALLOWED_DOMAIN, ASTRE_SEED_IDS, runAstreSeed } from '../../prisma/seed-astre.js';

// Aramo-Domain-Enforcement-P3 (LOCKED) §7 — one organization per email domain on
// REAL PostgreSQL 17 (the full identity migration set incl.
// 20261022110000_domain_enforcement_p3, the real TenantService + DomainClaimService):
//   #3  concurrent claims: exactly one wins
//   #4  an expired PROVISIONAL lapses on the next claim; the lapsed tenant + data remain
//   #5  a soft-disabled saga failure lapses the claim
//   #6  CLOSED keeps the claim; an operator release frees it
//   #7  SUSPENDED keeps the claim
//   #8  matching is case-insensitive
//   #9  PERSONAL tenants are unaffected
//   #10 an exception is granted (audited) and lets a second tenant in
//   #11 revoking it conflicts with the other holder, fails closed, changes nothing
//   #12 P2b VERIFIED promotes to AUTHORITATIVE; a held-elsewhere promotion is refused
//   #16 grandfathering: migration backfill + the Astre seed (idempotent; P2b untouched)
// (#1, #2, #17 — the console and signup surfaces — live in apps/platform-admin.)

const ROOT = resolve(__dirname, '../../../..');
const ALL_MIGRATIONS = resolveIdentityMigrations(ROOT);
const P3_MIGRATION = ALL_MIGRATIONS.find((p) => p.includes('20261022110000_domain_enforcement_p3'))!;
const BEFORE_P3 = ALL_MIGRATIONS.filter((p) => p !== P3_MIGRATION);

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_TENANT = '01900000-0000-7000-8000-00000000d301';
const LEGACY_PERSONAL = '01900000-0000-7000-8000-00000000d302';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Domain-Enforcement P3 — one organization per email domain (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let tenants: TenantService;
  let claims: DomainClaimService;
  let n = 0;
  const ACTOR = '01900000-0000-7000-8000-00000000d3aa';
  const uniq = (p: string) => `${p} ${++n}`;

  async function apply(paths: readonly string[]): Promise<void> {
    for (const p of paths) {
      for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
        const t = stmt.trim();
        if (t.length > 0) await prisma.$executeRawUnsafe(t);
      }
    }
  }
  const provision = (name: string, owner_email: string, kind?: string) =>
    tenants.provisionTenant({ name, owner_email, actor_user_id: ACTOR, ...(kind === undefined ? {} : { kind }) });
  const claimRow = (tenant_id: string) => prisma.tenantDomainClaim.findUnique({ where: { tenant_id } });
  const events = (tenant_id: string, event_type: string) =>
    prisma.identityAuditEvent.findMany({ where: { tenant_id, event_type }, orderBy: { created_at: 'asc' } });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    // Every migration BEFORE P3, then pre-existing tenants, then P3 — so the
    // grandfather backfill and the pre-flight guard run against real rows.
    await apply(BEFORE_P3);
    await prisma.tenant.create({ data: { id: LEGACY_TENANT, name: 'Legacy Co', allowed_domain: 'Legacy-Co.Example' } });
    await prisma.tenant.create({ data: { id: LEGACY_PERSONAL, name: 'Legacy Person', kind: 'PERSONAL' } });
    await apply([P3_MIGRATION]);
    const audit = new IdentityAuditService(new IdentityAuditRepository(prisma), createAramoLogger('p3-spec'));
    claims = new DomainClaimService(prisma);
    tenants = new TenantService(new TenantRepository(prisma), audit, claims);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  // ── #16 grandfathering ─────────────────────────────────────────────────────

  it('#16 the migration grandfathers every existing BUSINESS domain tenant as AUTHORITATIVE (lower-cased); PERSONAL gets no claim', async () => {
    expect(await claimRow(LEGACY_TENANT)).toMatchObject({ domain: 'legacy-co.example', claim: 'AUTHORITATIVE', reason: 'grandfathered', exception: false, expires_at: null });
    expect(await claimRow(LEGACY_PERSONAL)).toBeNull();
    // allowed_domain itself is never rewritten.
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: LEGACY_TENANT } })).allowed_domain).toBe('Legacy-Co.Example');
    await expect(provision(uniq('Legacy Rival'), 'x@LEGACY-CO.example')).rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE', statusCode: 409 });
  });

  it('#16 the migration pre-flight refuses duplicate BUSINESS domains (and changes nothing)', async () => {
    const guard = splitDdl(readFileSync(P3_MIGRATION, 'utf8')).map((s) => s.trim()).find((s) => s.includes('P3 pre-flight'))!;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.tenant.create({ data: { id: '01900000-0000-7000-8000-00000000d3f1', name: 'Dup A', allowed_domain: 'dup.example' } });
        await tx.tenant.create({ data: { id: '01900000-0000-7000-8000-00000000d3f2', name: 'Dup B', allowed_domain: 'DUP.example' } });
        await tx.$executeRawUnsafe(guard);
      }),
    ).rejects.toThrow(/P3 pre-flight/);
    expect(await prisma.tenant.count({ where: { allowed_domain: { equals: 'dup.example', mode: 'insensitive' } } })).toBe(0);
  });

  it('#16 Astre regression: the seed sets the grandfathered AUTHORITATIVE claim, idempotently, without touching P2b', async () => {
    await runAstreSeed(prisma);
    const first = await claimRow(ASTRE_SEED_IDS.tenant);
    expect(first).toMatchObject({ domain: ASTRE_ALLOWED_DOMAIN, claim: 'AUTHORITATIVE', reason: 'grandfathered', exception: false });
    const astre = await prisma.tenant.findUniqueOrThrow({ where: { id: ASTRE_SEED_IDS.tenant } });
    expect(astre.domain_verification_status).toBe('UNVERIFIED');
    await runAstreSeed(prisma);
    expect(await claimRow(ASTRE_SEED_IDS.tenant)).toEqual(first);
    expect(await prisma.tenantDomainClaim.count({ where: { domain: ASTRE_ALLOWED_DOMAIN } })).toBe(1);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: ASTRE_SEED_IDS.tenant } })).domain_verification_status).toBe('UNVERIFIED');
    expect(await claims.isAuthoritative(ASTRE_SEED_IDS.tenant)).toBe(true);
    // A second astreinc.com organization is refused.
    await expect(provision(uniq('Astre Two'), 'someone@astreinc.com')).rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE' });
  });

  // ── creation ───────────────────────────────────────────────────────────────

  it('a new BUSINESS tenant is born PROVISIONAL for 30 days (audited in the same transaction); a second one on the domain is refused and creates nothing', async () => {
    const before = Date.now();
    const t = await provision(uniq('Fresh Org'), 'owner@fresh.example');
    const row = await claimRow(t.id);
    expect(row).toMatchObject({ domain: 'fresh.example', claim: 'PROVISIONAL', reason: 'provisioned', exception: false });
    const expiresIn = row!.expires_at!.getTime() - before;
    expect(expiresIn).toBeGreaterThanOrEqual(DOMAIN_CLAIM_PROVISIONAL_DAYS * DAY_MS - 5_000);
    expect(expiresIn).toBeLessThanOrEqual(DOMAIN_CLAIM_PROVISIONAL_DAYS * DAY_MS + 60_000);
    expect(await events(t.id, 'identity.domain.claim.provisional')).toHaveLength(1);
    const count = await prisma.tenant.count();
    await expect(provision(uniq('Fresh Rival'), 'other@fresh.example')).rejects.toMatchObject({
      code: 'TENANT_DOMAIN_UNAVAILABLE',
      statusCode: 409,
      context: { details: { reason: 'organization_domain_taken' } },
    });
    expect(await prisma.tenant.count()).toBe(count);
  });

  it('#8 matching is case-insensitive', async () => {
    await provision(uniq('Case Org'), 'a@case-match.example');
    await expect(provision(uniq('Case Rival'), 'B@CASE-Match.EXAMPLE')).rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE' });
    expect(await claims.isDomainHeld('CASE-MATCH.example')).toBe(true);
  });

  it('#3 concurrent claims on one domain: exactly one wins; the losers leave no tenant row', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => provision(uniq(`Race ${i}`), `user${i}@race.example`)),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(4);
    for (const l of lost) expect(l.reason).toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE' });
    expect(await prisma.tenant.count({ where: { allowed_domain: 'race.example' } })).toBe(1);
    expect(await prisma.tenantDomainClaim.count({ where: { domain: 'race.example' } })).toBe(1);
  });

  it('#9 PERSONAL tenants are unaffected (no claim; free-mail is never held)', async () => {
    const a = await provision(uniq('Person A'), 'same.person@gmail.com', 'PERSONAL');
    const b = await provision(uniq('Person B'), 'other.person@gmail.com', 'PERSONAL');
    expect(await claimRow(a.id)).toBeNull();
    expect(await claimRow(b.id)).toBeNull();
    expect(await claims.isDomainHeld('gmail.com')).toBe(false);
  });

  // ── lapse ──────────────────────────────────────────────────────────────────

  it('#4 an expired PROVISIONAL claim lapses on the next claim attempt; the lapsed tenant and its data remain', async () => {
    const old = await provision(uniq('Expiring Org'), 'owner@expiring.example');
    await prisma.tenantDomainClaim.update({ where: { tenant_id: old.id }, data: { expires_at: new Date(Date.now() - 1000) } });
    expect(await claims.isDomainHeld('expiring.example')).toBe(false);
    const next = await provision(uniq('Expiring Successor'), 'owner@expiring.example');
    expect(await claimRow(old.id)).toMatchObject({ claim: 'LAPSED', reason: 'reservation_expired' });
    expect(await claimRow(next.id)).toMatchObject({ claim: 'PROVISIONAL' });
    const kept = await prisma.tenant.findUniqueOrThrow({ where: { id: old.id } });
    expect(kept).toMatchObject({ is_active: true, allowed_domain: 'expiring.example' });
    expect(await events(old.id, 'identity.tenant.created')).toHaveLength(1);
    expect(await events(old.id, 'identity.domain.claim.lapsed')).toHaveLength(1);
  });

  it('the opt-in sweep lapses every expired PROVISIONAL claim (and nothing else)', async () => {
    const a = await provision(uniq('Sweep A'), 'o@sweep-a.example');
    const b = await provision(uniq('Sweep B'), 'o@sweep-b.example');
    await prisma.tenantDomainClaim.update({ where: { tenant_id: a.id }, data: { expires_at: new Date(Date.now() - 1000) } });
    expect(await claims.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await claimRow(a.id)).toMatchObject({ claim: 'LAPSED', reason: 'reservation_expired' });
    expect(await claimRow(b.id)).toMatchObject({ claim: 'PROVISIONAL' });
    expect(await claims.sweepExpired()).toBe(0);
  });

  it('#5 a soft-disabled saga failure lapses the claim (provisioning_failed); the domain is free again', async () => {
    const failed = await provision(uniq('Failed Saga'), 'owner@failed-saga.example');
    await tenants.deactivateTenant({ tenant_id: failed.id, actor_user_id: ACTOR, reason: 'entitlement_grant_failed' });
    expect(await claimRow(failed.id)).toMatchObject({ claim: 'LAPSED', reason: 'provisioning_failed' });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: failed.id } })).is_active).toBe(false);
    const retry = await provision(uniq('Failed Saga Retry'), 'owner@failed-saga.example');
    expect(await claimRow(retry.id)).toMatchObject({ claim: 'PROVISIONAL' });
  });

  // ── lifecycle ──────────────────────────────────────────────────────────────

  it('#6 CLOSED keeps the claim; an audited operator release frees it', async () => {
    const t = await provision(uniq('Closing Org'), 'o@closing.example');
    await tenants.transitionTenantStatus({ tenant_id: t.id, to: 'CLOSED', actor_id: ACTOR, actor_type: 'user', source: 'spec', reason_code: 'test', reason_text: 'test' });
    expect(await claimRow(t.id)).toMatchObject({ claim: 'PROVISIONAL' });
    await expect(provision(uniq('Closing Rival'), 'x@closing.example')).rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE' });
    const released = await claims.release(t.id, ACTOR, 'organization closed; domain transferred');
    expect(released).toMatchObject({ claim: 'RELEASED', reason: 'organization closed; domain transferred' });
    const ev = await events(t.id, 'identity.domain.claim.released');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_type: 'user', actor_id: ACTOR });
    const next = await provision(uniq('Closing Successor'), 'x@closing.example');
    expect(await claimRow(next.id)).toMatchObject({ claim: 'PROVISIONAL' });
    // Releasing again is a no-op (no second event).
    await claims.release(t.id, ACTOR, 'again');
    expect(await events(t.id, 'identity.domain.claim.released')).toHaveLength(1);
  });

  it('#7 SUSPENDED keeps the claim', async () => {
    const t = await provision(uniq('Suspended Org'), 'o@suspended.example');
    await tenants.transitionTenantStatus({ tenant_id: t.id, to: 'ACTIVE', actor_id: ACTOR, actor_type: 'system', source: 'spec' });
    await tenants.transitionTenantStatus({ tenant_id: t.id, to: 'SUSPENDED', actor_id: ACTOR, actor_type: 'user', source: 'spec', reason_code: 'test', reason_text: 'test' });
    expect(await claimRow(t.id)).toMatchObject({ claim: 'PROVISIONAL' });
    await expect(provision(uniq('Suspended Rival'), 'x@suspended.example')).rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE' });
  });

  // ── exceptions ─────────────────────────────────────────────────────────────

  it('#10 an audited exception lets a second tenant in; #11 revoking it while the other holds fails closed and changes nothing', async () => {
    const a = await provision(uniq('Shared A'), 'o@shared.example');
    const granted = await claims.grantException(a.id, ACTOR, 'two legal entities share one mail domain', 'TICKET-123');
    expect(granted).toMatchObject({ claim: 'PROVISIONAL', exception: true });
    const ex = await prisma.tenantDomainException.findMany({ where: { tenant_id: a.id } });
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ domain: 'shared.example', justification: 'two legal entities share one mail domain', evidence_ref: 'TICKET-123', granted_by_user_id: ACTOR, revoked_at: null });
    expect(await events(a.id, 'identity.domain.exception.granted')).toHaveLength(1);
    // A is no longer the holder; B gets in.
    const b = await provision(uniq('Shared B'), 'p@shared.example');
    expect(await claimRow(b.id)).toMatchObject({ claim: 'PROVISIONAL', exception: false });

    const beforeA = await claimRow(a.id);
    const beforeB = await claimRow(b.id);
    await expect(claims.revokeException(a.id, ACTOR)).rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE', statusCode: 409 });
    expect(await claimRow(a.id)).toEqual(beforeA);
    expect(await claimRow(b.id)).toEqual(beforeB);
    expect((await prisma.tenantDomainException.findFirstOrThrow({ where: { tenant_id: a.id } })).revoked_at).toBeNull();
    expect(await events(a.id, 'identity.domain.exception.revoked')).toHaveLength(0);

    // Once B no longer holds, the revoke succeeds and marks the exception row.
    await claims.release(b.id, ACTOR, 'moved');
    const revoked = await claims.revokeException(a.id, ACTOR);
    expect(revoked).toMatchObject({ exception: false, claim: 'PROVISIONAL' });
    expect((await prisma.tenantDomainException.findFirstOrThrow({ where: { tenant_id: a.id } })).revoked_by_user_id).toBe(ACTOR);
    expect(await events(a.id, 'identity.domain.exception.revoked')).toHaveLength(1);
  });

  // ── promotion (P2b VERIFIED + operator evidence) ───────────────────────────

  it('#12 P2b VERIFIED promotes the tenant\'s own PROVISIONAL claim to AUTHORITATIVE (audited); a second call is ALREADY', async () => {
    const t = await provision(uniq('Verified Org'), 'o@verified.example');
    expect(await claims.promoteOnVerified(t.id)).toBe('PROMOTED');
    expect(await claimRow(t.id)).toMatchObject({ claim: 'AUTHORITATIVE', reason: 'domain_verified', expires_at: null });
    expect(await claims.isAuthoritative(t.id)).toBe(true);
    const ev = await events(t.id, 'identity.domain.claim.authoritative');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.event_payload).toMatchObject({ domain: 'verified.example', from: 'PROVISIONAL', reason: 'domain_verified' });
    expect(await claims.promoteOnVerified(t.id)).toBe('ALREADY');
    // Promotion does not fake P2b status.
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })).domain_verification_status).toBe('UNVERIFIED');
  });

  it('#12 a held-elsewhere promotion is refused (CONFLICT, nothing changes); a lapsed tenant re-claims once the domain is free', async () => {
    const lapsed = await provision(uniq('Lapsed Org'), 'o@reclaim.example');
    await tenants.deactivateTenant({ tenant_id: lapsed.id, actor_user_id: ACTOR, reason: 'policy_package_publish_failed' });
    const holder = await provision(uniq('Holder Org'), 'o@reclaim.example');
    expect(await claims.promoteOnVerified(lapsed.id)).toBe('CONFLICT');
    expect(await claimRow(lapsed.id)).toMatchObject({ claim: 'LAPSED' });
    expect(await claimRow(holder.id)).toMatchObject({ claim: 'PROVISIONAL' });
    expect(await events(lapsed.id, 'identity.domain.claim.authoritative')).toHaveLength(0);
    await expect(claims.promoteWithEvidence(lapsed.id, ACTOR, 'DNS-SCREENSHOT-1')).rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE' });

    await claims.release(holder.id, ACTOR, 'abandoned');
    expect(await claims.promoteOnVerified(lapsed.id)).toBe('PROMOTED');
    expect(await claimRow(lapsed.id)).toMatchObject({ claim: 'AUTHORITATIVE' });
  });

  it('#12 an expired provisional holder does not block promotion; a BUSINESS tenant without a claim row gets one; PERSONAL is NO_DOMAIN', async () => {
    const stale = await provision(uniq('Stale Holder'), 'o@promote-expired.example');
    await prisma.tenantDomainClaim.update({ where: { tenant_id: stale.id }, data: { expires_at: new Date(Date.now() - 1000) } });
    const rowless = '01900000-0000-7000-8000-00000000d3c1';
    await prisma.tenant.create({ data: { id: rowless, name: uniq('Rowless'), allowed_domain: 'Promote-Expired.example' } });
    expect(await claims.promoteOnVerified(rowless)).toBe('PROMOTED');
    expect(await claimRow(rowless)).toMatchObject({ domain: 'promote-expired.example', claim: 'AUTHORITATIVE', reason: 'domain_verified' });
    expect(await claimRow(stale.id)).toMatchObject({ claim: 'LAPSED', reason: 'reservation_expired' });
    expect(await claims.promoteOnVerified(LEGACY_PERSONAL)).toBe('NO_DOMAIN');
  });

  it('operator promotion with evidence records the reference (audited)', async () => {
    const t = await provision(uniq('Evidence Org'), 'o@evidence.example');
    expect(await claims.promoteWithEvidence(t.id, ACTOR, 'TICKET-9')).toMatchObject({ claim: 'AUTHORITATIVE', reason: 'operator_evidence' });
    const ev = await events(t.id, 'identity.domain.claim.authoritative');
    expect(ev[0]).toMatchObject({ actor_type: 'user', actor_id: ACTOR });
    expect(ev[0]!.event_payload).toMatchObject({ evidence_ref: 'TICKET-9' });
  });

  it('the holder index itself refuses a second holder (the database is the backstop)', async () => {
    const t = await provision(uniq('Index Org'), 'o@index.example');
    await expect(
      prisma.tenantDomainClaim.create({ data: { tenant_id: LEGACY_PERSONAL, domain: 'index.example', claim: 'AUTHORITATIVE' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await claimRow(t.id)).toMatchObject({ claim: 'PROVISIONAL' });
  });
});
