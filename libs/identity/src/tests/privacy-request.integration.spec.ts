import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations } from '@aramo/common';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PrivacyRequestService } from '../lib/privacy/privacy-request.service.js';
import { PrivacySubjectService } from '../lib/privacy/privacy-subject.service.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.1 — the platform privacy-request record on REAL
// PostgreSQL 17 with the full identity migration set (incl. 20261030030000_privacy_requests):
// lifecycle legality + concurrency guard, every change evented, the one-time proof
// (single use, expiry, repeat answers the same request), contact protection, the
// Business member Sign-access removal (org-wide roles kept) and the DB guards.

const ROOT = resolve(__dirname, '../../../..');
const splitDdl = (sql: string) => sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
const SYS = { actor_type: 'SYSTEM' as const, actor_id: null };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('privacy requests — identity record (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let svc: PrivacyRequestService;
  let subjects: PrivacySubjectService;
  const savedKey = process.env['PRIVACY_REQUEST_EMAIL_KEY'];

  beforeAll(async () => {
    process.env['PRIVACY_REQUEST_EMAIL_KEY'] = randomBytes(32).toString('base64');
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    for (const p of resolveIdentityMigrations(ROOT)) {
      for (const stmt of splitDdl(readFileSync(p, 'utf8'))) if (stmt.trim().length > 0) await prisma.$executeRawUnsafe(stmt.trim());
    }
    svc = new PrivacyRequestService(prisma);
    subjects = new PrivacySubjectService(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
    if (savedKey === undefined) delete process.env['PRIVACY_REQUEST_EMAIL_KEY'];
    else process.env['PRIVACY_REQUEST_EMAIL_KEY'] = savedKey;
  });

  it('creates with a reference and a 30-day due date; refuses illegal transitions; evented', async () => {
    const r = await svc.create({ product: 'SIGN', request_type: 'DELETION', subject_kind: 'GUEST_SIGNER', channel: 'OPERATOR', contact_email: 'Guest@Example.com', actor: SYS });
    expect(r.status).toBe('RECEIVED');
    expect(r.due_at.getTime() - r.created_at.getTime()).toBe(30 * 86_400_000);
    expect(r.contact_email_ciphertext).not.toContain('guest');
    expect(svc.contactEmail(r)).toBe('guest@example.com');
    expect(svc.contactMatches(r, 'GUEST@example.com')).toBe(true);
    await expect(svc.transition(r.id, 'EXECUTING', SYS)).rejects.toMatchObject({ statusCode: 409 });
    const v = await svc.transition(r.id, 'IDENTITY_VALIDATED', SYS);
    expect(v.identity_validated_at).not.toBeNull();
    await expect(svc.transition(r.id, 'DATA_INVENTORY', SYS, { from: ['RECEIVED'] })).rejects.toMatchObject({ statusCode: 409 });
    const d = await svc.transition(r.id, 'DENIED_WITH_REASON', SYS, { patch: { outcome_text: 'Not ours' } });
    expect(d.completed_at).not.toBeNull();
    await expect(svc.transition(r.id, 'CANCELLED', SYS)).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.assign(r.id, randomUUID(), SYS, 'rq')).rejects.toMatchObject({ statusCode: 409 });
    expect((await svc.events(r.id)).map((e) => [e.event_type, e.to_status])).toEqual([
      ['CREATED', 'RECEIVED'],
      ['STATUS_CHANGED', 'IDENTITY_VALIDATED'],
      ['STATUS_CHANGED', 'DENIED_WITH_REASON'],
    ]);
  });

  it('the email proof is single-use, expires, and a repeat answers the request it created', async () => {
    const now = new Date('2026-10-28T10:00:00.000Z');
    const p = await svc.issueEmailProof({ email: 'Pat@Example.com', request_type: 'DELETION', product: 'SIGN', now });
    expect(await svc.consumeEmailProof(p.token, new Date(now.getTime() + 61 * 60_000))).toBeNull();
    const first = await svc.consumeEmailProof(p.token, now);
    expect(first).toMatchObject({ kind: 'fresh', email: 'pat@example.com', request_type: 'DELETION' });
    // Consumed but not yet linked: nothing to answer.
    expect(await svc.consumeEmailProof(p.token, now)).toBeNull();
    if (first?.kind !== 'fresh') throw new Error('expected fresh');
    const r = await svc.create({ product: 'SIGN', request_type: 'DELETION', subject_kind: 'GUEST_SIGNER', channel: 'WEB', contact_protected: first.contact, actor: SYS, now });
    await svc.linkProof(first.proof_id, r.id);
    expect(await svc.consumeEmailProof(p.token, now)).toEqual({ kind: 'repeat', request_id: r.id });
    expect(await svc.consumeEmailProof('x'.repeat(43), now)).toBeNull();
    expect(await svc.proofCountSince('pat@example.com', new Date(now.getTime() - 1000))).toBe(1);
  });

  it('removeSignAccess removes only the Sign roles; retireAccountHolder deactivates; otherAuthorization sees other memberships', async () => {
    const tenant = randomUUID();
    await prisma.tenant.create({ data: { id: tenant, name: `Org ${tenant.slice(0, 6)}` } });
    const roles: Record<string, string> = {};
    for (const key of ['sign_sender', 'sign_viewer', 'tenant_admin']) {
      const existing = await prisma.role.findUnique({ where: { key } });
      roles[key] = existing?.id ?? (await prisma.role.create({ data: { id: randomUUID(), key, description: key } })).id;
    }
    const user = randomUUID();
    await prisma.user.create({ data: { id: user, email: `m-${user.slice(0, 6)}@org.test`, tenant_id: tenant } });
    const m = await prisma.userTenantMembership.create({ data: { id: randomUUID(), user_id: user, tenant_id: tenant } });
    for (const k of Object.keys(roles)) await prisma.userTenantMembershipRole.create({ data: { id: randomUUID(), membership_id: m.id, role_id: roles[k]! } });
    const res = await subjects.removeSignAccess(user, tenant);
    expect(res).toEqual({ roles_removed: 2, remaining_role_keys: ['tenant_admin'] });
    expect(await subjects.removeSignAccess(user, tenant)).toEqual({ roles_removed: 0, remaining_role_keys: ['tenant_admin'] });
    const ctx = await subjects.context(user, tenant);
    expect(ctx).toMatchObject({ tenant_kind: 'BUSINESS', legal_hold: false, membership_active: true, is_owner: false });
    expect(await subjects.context(user, randomUUID())).toBeNull();
    expect((await subjects.otherAuthorization(user, tenant)).retain).toBe(false);
    expect(await subjects.findAccountByEmail(`M-${user.slice(0, 6)}@ORG.test`)).toEqual({ user_id: user, tenant_id: tenant });
    expect(await subjects.retireAccountHolder(user, tenant)).toEqual({ memberships_deactivated: 1, users_deactivated: 1 });
    expect(await subjects.retireAccountHolder(user, tenant)).toEqual({ memberships_deactivated: 0, users_deactivated: 0 });
  });

  it('DB guards: events append-only; requests never deleted', async () => {
    const r = await svc.create({ product: 'SIGN', request_type: 'ACCESS', subject_kind: 'GUEST_SIGNER', channel: 'OPERATOR', actor: SYS });
    await expect(prisma.privacyRequestEvent.updateMany({ where: { request_id: r.id }, data: { event_type: 'X' } })).rejects.toThrow();
    await expect(prisma.privacyRequestEvent.deleteMany({ where: { request_id: r.id } })).rejects.toThrow();
    await expect(prisma.privacyRequest.delete({ where: { id: r.id } })).rejects.toThrow();
  });
});
