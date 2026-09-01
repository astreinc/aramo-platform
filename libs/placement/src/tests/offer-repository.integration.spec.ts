import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AramoError } from '@aramo/common';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { OfferRepository } from '../lib/offer.repository.js';
import { OfferTransitionPolicyService } from '../lib/policy/offer-transition-policy.service.js';
import { OFFER_LIFECYCLE_PACKAGE_NAME, OFFER_RESOURCE, OFFER_TRANSITION_ACTIONS } from '../lib/lifecycle/offer-lifecycle.js';

// Offer Lifecycle — D5 (OfferRepository, real Postgres 17). Proves create /
// findById / transition end-to-end against the generated trigger AND the
// fail-closed ADR-0024 policy governance: no published package = DENY; a
// published permissive package = ALLOW along legal edges; illegal edge = 409.

const ROOT = resolve(__dirname, '../../../..');
const OFFER_MIG = resolve(ROOT, 'libs/placement/prisma/migrations/20260824120000_init_offer_model/migration.sql');
// L4 P1 — Offer.comp_* columns (ADD nullable; regenerated client SELECTs them on every offer read). SEPARATE const.
const OFFER_COMPENSATION_MIG = resolve(ROOT, 'libs/placement/prisma/migrations/20260901130000_offer_compensation_snapshot/migration.sql');
const OFFER_REVISION_MIG = resolve(ROOT, 'libs/placement/prisma/migrations/20260901140000_offer_revision_history/migration.sql');
const POLICY_MIGS = [
  resolve(ROOT, 'libs/policy-store/prisma/migrations/20260730120000_init_policy_store/migration.sql'),
  resolve(ROOT, 'libs/policy-store/prisma/migrations/20260730160000_add_policy_decision_record/migration.sql'),
];
const SYSTEM = '00000000-0000-0000-0000-000000000000';
let ctr = 0;
const uuid = (): string => `00000000-0000-7000-8000-${(++ctr).toString(16).padStart(12, '0')}`;
const TENANT = '01900000-0000-7000-8000-0000000000f2';
const ACTOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaae1';
const SCOPES = ['offer:create', 'offer:transition'];

// A minimal permissive offer package (every legal edge ALLOW) — the DATA proof
// (D3) covers the real derived matrix; here we just need ALLOW to publish.
function permissivePackage() {
  return {
    name: OFFER_LIFECYCLE_PACKAGE_NAME,
    version: '1.0.0',
    registry: { resources: [OFFER_RESOURCE], actions: [...OFFER_TRANSITION_ACTIONS] },
    default_disposition: { decision: 'ALLOW' as const, reason_code: 'OFFER_ALLOWED_DEFAULT' },
    rules: [],
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'OfferRepository (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let admin: Client;
    let prisma: PrismaService;
    let storePrisma: PolicyStorePrismaService;
    let store: PolicyStore;
    let repo: OfferRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      admin = new Client({ connectionString: url });
      await admin.connect();
      await admin.query(readFileSync(OFFER_MIG, 'utf8'));
      await admin.query(readFileSync(OFFER_COMPENSATION_MIG, 'utf8'));
      await admin.query(readFileSync(OFFER_REVISION_MIG, 'utf8'));
      for (const p of POLICY_MIGS) await admin.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      storePrisma = new PolicyStorePrismaService(url);
      await storePrisma.$connect();
      store = new PolicyStore(storePrisma);
      repo = new OfferRepository(prisma, new OfferTransitionPolicyService(store));
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await storePrisma?.$disconnect();
      await admin?.end();
      await container?.stop();
    });

    async function mkOffer() {
      return repo.create({
        tenant_id: TENANT, submittal_id: uuid(), requisition_id: uuid(), talent_record_id: uuid(),
        actor_id: ACTOR, correlation_id: uuid(),
      });
    }

    it('create → DRAFT, findById returns it', async () => {
      const o = await mkOffer();
      expect(o.state).toBe('DRAFT');
      const read = await repo.findById(TENANT, o.id);
      expect(read?.id).toBe(o.id);
    });

    it('FAIL-CLOSED: transition with NO published package → POLICY_DENIED (403)', async () => {
      const o = await mkOffer();
      let err: AramoError | undefined;
      try {
        await repo.transition({ tenant_id: TENANT, id: o.id, to_state: 'SENT', scopes: SCOPES, actor_id: ACTOR, correlation_id: uuid() });
      } catch (e) { err = e as AramoError; }
      expect(err?.code).toBe('POLICY_DENIED');
      expect(err?.statusCode).toBe(403);
      // no mutation — still DRAFT
      expect((await repo.findById(TENANT, o.id))?.state).toBe('DRAFT');
    });

    it('with a published package: DRAFT → SENT → NEGOTIATION → ACCEPTED (legal edges ALLOW)', async () => {
      await store.publish({ tenant_id: TENANT, definition: permissivePackage(), published_by: SYSTEM });
      const o = await mkOffer();
      await repo.transition({ tenant_id: TENANT, id: o.id, to_state: 'SENT', scopes: SCOPES, actor_id: ACTOR, correlation_id: uuid() });
      await repo.transition({ tenant_id: TENANT, id: o.id, to_state: 'NEGOTIATION', scopes: SCOPES, actor_id: ACTOR, correlation_id: uuid() });
      const accepted = await repo.transition({ tenant_id: TENANT, id: o.id, to_state: 'ACCEPTED', scopes: SCOPES, actor_id: ACTOR, correlation_id: uuid() });
      expect(accepted.state).toBe('ACCEPTED');
    });

    it('P2 — create records revision #1; a NEGOTIATION comp revision appends #2 (monotonic; prior preserved)', async () => {
      // offer-lifecycle@1.0.0 is already published (immutable) by the legal-edges
      // test above and persists in the shared DB — reuse it for the transitions.
      const o = await repo.create({
        tenant_id: TENANT, submittal_id: uuid(), requisition_id: uuid(), talent_record_id: uuid(),
        compensation_type: 'CONTRACT', compensation_amount: '85', compensation_currency: 'USD', compensation_period: 'HOURLY',
        actor_id: ACTOR, correlation_id: uuid(),
      });
      const afterCreate = await prisma.offerRevision.findMany({ where: { tenant_id: TENANT, offer_id: o.id }, orderBy: { revision_number: 'asc' } });
      expect(afterCreate).toHaveLength(1);
      expect(afterCreate[0]!.revision_number).toBe(1);
      expect(afterCreate[0]!.compensation_amount?.toString()).toBe('85');

      // A pure state transition (no terms) records NO revision.
      await repo.transition({ tenant_id: TENANT, id: o.id, to_state: 'SENT', scopes: SCOPES, actor_id: ACTOR, correlation_id: uuid() });
      expect(await prisma.offerRevision.count({ where: { tenant_id: TENANT, offer_id: o.id } })).toBe(1);

      // NEGOTIATION revising comp → revision #2 + the Offer current snapshot updates.
      const negotiated = await repo.transition({
        tenant_id: TENANT, id: o.id, to_state: 'NEGOTIATION', scopes: SCOPES, actor_id: ACTOR, correlation_id: uuid(),
        compensation_type: 'CONTRACT', compensation_amount: '95', compensation_currency: 'USD', compensation_period: 'HOURLY',
        change_reason: 'counter-offer',
      });
      expect(negotiated.compensation_amount).toBe('95');
      const revs = await prisma.offerRevision.findMany({ where: { tenant_id: TENANT, offer_id: o.id }, orderBy: { revision_number: 'asc' } });
      expect(revs.map((r) => r.revision_number)).toEqual([1, 2]);
      expect(revs[1]!.compensation_amount?.toString()).toBe('95');
      expect(revs[1]!.change_reason).toBe('counter-offer');
      // No overwrite-in-place — the prior version is preserved.
      expect(revs[0]!.compensation_amount?.toString()).toBe('85');
    });

    it('P2 — OfferRevision is append-only (UPDATE/DELETE rejected at the DB)', async () => {
      // create() needs no published policy (only transitions do); no publish here.
      const o = await repo.create({
        tenant_id: TENANT, submittal_id: uuid(), requisition_id: uuid(), talent_record_id: uuid(),
        compensation_type: 'PERMANENT', compensation_amount: '145000', compensation_currency: 'USD', compensation_period: 'ANNUAL',
        actor_id: ACTOR, correlation_id: uuid(),
      });
      await expect(
        admin.query(`UPDATE "offer"."OfferRevision" SET change_reason = 'x' WHERE offer_id = $1`, [o.id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        admin.query(`DELETE FROM "offer"."OfferRevision" WHERE offer_id = $1`, [o.id]),
      ).rejects.toThrow(/append-only/);
    });

    it('P6 — expireOverdueOffers expires overdue SENT/NEGOTIATION; DRAFT + future untouched; idempotent', async () => {
      const NOW = new Date('2026-09-01T00:00:00.000Z');
      const past = new Date('2026-08-01T00:00:00.000Z');
      const future = new Date('2026-12-01T00:00:00.000Z');
      const seed = async (state: string, expires: Date): Promise<string> => {
        const id = uuid();
        await prisma.offer.create({
          data: {
            id, tenant_id: TENANT, submittal_id: uuid(), requisition_id: uuid(),
            talent_record_id: uuid(), state: state as never, offer_expires_at: expires,
          },
        });
        return id;
      };
      const sent = await seed('SENT', past); // overdue → expires
      const nego = await seed('NEGOTIATION', past); // overdue → expires
      const draft = await seed('DRAFT', past); // overdue but no EXPIRED edge → untouched
      const futureSent = await seed('SENT', future); // not overdue → untouched

      const r1 = await repo.expireOverdueOffers(NOW, SYSTEM);
      expect(r1.expired).toBe(2);
      expect((await repo.findById(TENANT, sent))?.state).toBe('EXPIRED');
      expect((await repo.findById(TENANT, nego))?.state).toBe('EXPIRED');
      expect((await repo.findById(TENANT, draft))?.state).toBe('DRAFT');
      expect((await repo.findById(TENANT, futureSent))?.state).toBe('SENT');

      // Each expiry is audited: a state_transition event + an offer.expire outbox row.
      expect(await prisma.offerEvent.count({ where: { tenant_id: TENANT, offer_id: sent } })).toBeGreaterThanOrEqual(1);
      expect(await prisma.offerOutboxEvent.count({ where: { tenant_id: TENANT, event_type: 'offer.expire' } })).toBe(2);

      // Idempotent: a second sweep at the same instant expires nothing more.
      const r2 = await repo.expireOverdueOffers(NOW, SYSTEM);
      expect(r2.expired).toBe(0);
    });

    it('illegal edge DRAFT → ACCEPTED → OFFER_ILLEGAL_TRANSITION (409), no mutation', async () => {
      const o = await mkOffer();
      let err: AramoError | undefined;
      try {
        await repo.transition({ tenant_id: TENANT, id: o.id, to_state: 'ACCEPTED', scopes: SCOPES, actor_id: ACTOR, correlation_id: uuid() });
      } catch (e) { err = e as AramoError; }
      expect(err?.code).toBe('OFFER_ILLEGAL_TRANSITION');
      expect(err?.statusCode).toBe(409);
      expect((await repo.findById(TENANT, o.id))?.state).toBe('DRAFT');
    });

    it('one-live: a second offer for the same submittal → OFFER_ALREADY_LIVE (409)', async () => {
      const sub = uuid();
      await repo.create({ tenant_id: TENANT, submittal_id: sub, requisition_id: uuid(), talent_record_id: uuid(), actor_id: ACTOR, correlation_id: uuid() });
      let err: AramoError | undefined;
      try {
        await repo.create({ tenant_id: TENANT, submittal_id: sub, requisition_id: uuid(), talent_record_id: uuid(), actor_id: ACTOR, correlation_id: uuid() });
      } catch (e) { err = e as AramoError; }
      expect(err?.code).toBe('OFFER_ALREADY_LIVE');
      expect(err?.statusCode).toBe(409);
    });

    // D7 (LOCKED Aramo-Offer-D7-OfferPanel-Wiring v1.0, R-DISCOVERY) — the LIST
    // read the recruiter surface uses to discover an offer. Proves the filter
    // (submittal/requisition/talent), the visibility-set scoping, and — the
    // security invariant — cross-tenant isolation.
    describe('list() — D7 discovery + visibility', () => {
      const reqA = uuid();
      const reqB = uuid();
      const talentA = uuid();
      const FOREIGN = '01900000-0000-7000-8000-0000000000ff';
      let idA: string;
      let idB: string;

      beforeAll(async () => {
        idA = (await repo.create({ tenant_id: TENANT, submittal_id: uuid(), requisition_id: reqA, talent_record_id: talentA, actor_id: ACTOR, correlation_id: uuid() })).id;
        idB = (await repo.create({ tenant_id: TENANT, submittal_id: uuid(), requisition_id: reqB, talent_record_id: uuid(), actor_id: ACTOR, correlation_id: uuid() })).id;
        // A FOREIGN-tenant offer on the SAME requisition + talent — must NEVER
        // surface in TENANT's list (tenant_id is the hard isolation boundary).
        await repo.create({ tenant_id: FOREIGN, submittal_id: uuid(), requisition_id: reqA, talent_record_id: talentA, actor_id: ACTOR, correlation_id: uuid() });
      });

      it('filters by (requisition_id, talent_record_id); foreign tenant excluded', async () => {
        const byPair = await repo.list({ tenant_id: TENANT, requisition_id: reqA, talent_record_id: talentA, visible_requisition_ids: null });
        expect(byPair.map((o) => o.id)).toEqual([idA]);
      });

      it('filters by submittal_id', async () => {
        const sub = uuid();
        const o = await repo.create({ tenant_id: TENANT, submittal_id: sub, requisition_id: uuid(), talent_record_id: uuid(), actor_id: ACTOR, correlation_id: uuid() });
        const bySub = await repo.list({ tenant_id: TENANT, submittal_id: sub, visible_requisition_ids: null });
        expect(bySub.map((x) => x.id)).toEqual([o.id]);
      });

      it('visibility set restricts to visible requisitions; empty set ⇒ none', async () => {
        const onlyA = (await repo.list({ tenant_id: TENANT, visible_requisition_ids: new Set([reqA]) })).map((o) => o.id);
        expect(onlyA).toContain(idA);
        expect(onlyA).not.toContain(idB);
        const none = await repo.list({ tenant_id: TENANT, visible_requisition_ids: new Set() });
        expect(none).toEqual([]);
      });

      it('explicit requisition_id outside the visible set ⇒ empty (AND semantics)', async () => {
        const res = await repo.list({ tenant_id: TENANT, requisition_id: reqA, visible_requisition_ids: new Set([reqB]) });
        expect(res).toEqual([]);
      });

      it('cross-tenant: a foreign-tenant offer on the same requisition never leaks', async () => {
        const inTenant = await repo.list({ tenant_id: TENANT, requisition_id: reqA, visible_requisition_ids: null });
        expect(inTenant.map((o) => o.id)).toEqual([idA]);
      });
    });
  },
);
