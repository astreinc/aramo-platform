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
  },
);
