import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DocumentsRepository,
  DocumentIdempotencyService,
  RenderService,
  PrismaService as DocumentsPrismaService,
} from '@aramo/documents';
import { type SignatureProviderPort } from '@aramo/documents-contracts';
import {
  OfferRepository,
  OfferTransitionPolicyService,
  OFFER_LIFECYCLE_PACKAGE_NAME,
  OFFER_RESOURCE,
  OFFER_TRANSITION_ACTIONS,
  PrismaService as PlacementPrismaService,
} from '@aramo/placement';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';
import { type TalentRecordRepository } from '@aramo/talent-record';

import { OfferDocumentOrchestratorService, OFFER_LETTER_TYPE_ID } from '../offer-document/offer-document-orchestrator.service.js';

// DOC-6 B4 (R-6-10, PL-1/PL-2) — the load-bearing offer-letter proof on real Postgres
// 17. Proves the composition (request creates the OFFER_LETTER Document + the three
// associations; send prepares + creates/sends the envelope with the server-resolved
// Talent signer) AND the PL-1 invariant: signing produces evidence only — the Offer's
// governed state is BYTE-UNCHANGED across request→send (Document advances while
// Offer=SENT, the intended non-contradictory dual state). The E-Sign HTTP seam +
// rendering are stubbed (proven separately in libs/esign / DOC-5); this spec isolates
// DOC-6's new behaviour: the Offer read, the document creation, and no-state-mutation.

const ROOT = resolve(__dirname, '../../../..');
const TENANT = '01900000-0000-7000-8000-0000000000c6';
const ACTOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaac61';
const SYSTEM = '00000000-0000-0000-0000-000000000000';
const SCOPES = ['offer:create', 'offer:transition'];
let ctr = 0;
const uuid = (): string => `00000000-0000-7000-8000-${(++ctr).toString(16).padStart(12, '0')}`;

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const OFFER_MIGS = [
  'libs/placement/prisma/migrations/20260824120000_init_offer_model/migration.sql',
  'libs/placement/prisma/migrations/20260901130000_offer_compensation_snapshot/migration.sql',
  'libs/placement/prisma/migrations/20260901140000_offer_revision_history/migration.sql',
].map((p) => resolve(ROOT, p));
const POLICY_MIGS = [
  'libs/policy-store/prisma/migrations/20260730120000_init_policy_store/migration.sql',
  'libs/policy-store/prisma/migrations/20260730160000_add_policy_decision_record/migration.sql',
].map((p) => resolve(ROOT, p));

// A minimal permissive offer package (every legal edge ALLOW) — just enough to
// publish + transition the Offer to SENT for the dual-state proof.
function permissivePackage() {
  return {
    name: OFFER_LIFECYCLE_PACKAGE_NAME,
    version: '1.0.0',
    registry: { resources: [OFFER_RESOURCE], actions: [...OFFER_TRANSITION_ACTIONS] },
    default_disposition: { decision: 'ALLOW' as const, reason_code: 'OFFER_ALLOWED_DEFAULT' },
    rules: [],
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('DOC-6 offer-document orchestrator — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let admin: Client;
  let docsPrisma: DocumentsPrismaService;
  let placementPrisma: PlacementPrismaService;
  let storePrisma: PolicyStorePrismaService;
  let offers: OfferRepository;
  let orchestrator: OfferDocumentOrchestratorService;

  const createEnvelope = vi.fn(async () => ({ envelope_id: 'env-doc6-1', status: 'DRAFT', signers: [] }));
  const sendEnvelope = vi.fn(async () => ({ envelope_id: 'env-doc6-1', status: 'SENT', signers: [] }));
  const signature = { createEnvelope, sendEnvelope } as unknown as SignatureProviderPort;
  const render = {
    generateRevision: vi.fn(async () => ({ revision_id: uuid(), sha256: 'a'.repeat(64) })),
  } as unknown as RenderService;
  const talent = {
    findById: vi.fn(async () => ({ email1: 'jane.doe@example.com', first_name: 'Jane', last_name: 'Doe' })),
  } as unknown as TalentRecordRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    const url = container.getConnectionUri();
    admin = new Client({ connectionString: url });
    await admin.connect();
    // pg's native multi-statement query is comment-safe (no splitDdl trap).
    for (const m of documentsMigrations()) await admin.query(readFileSync(m, 'utf8'));
    for (const m of OFFER_MIGS) await admin.query(readFileSync(m, 'utf8'));
    for (const m of POLICY_MIGS) await admin.query(readFileSync(m, 'utf8'));

    docsPrisma = new DocumentsPrismaService(url);
    await docsPrisma.$connect();
    placementPrisma = new PlacementPrismaService(url);
    await placementPrisma.$connect();
    storePrisma = new PolicyStorePrismaService(url);
    await storePrisma.$connect();

    offers = new OfferRepository(placementPrisma, new OfferTransitionPolicyService(new PolicyStore(storePrisma)));
    orchestrator = new OfferDocumentOrchestratorService(
      new DocumentsRepository(docsPrisma, new DocumentIdempotencyService(docsPrisma)),
      render,
      signature,
      talent,
      offers,
    );

    // Publish a permissive offer package so the Offer can reach SENT.
    await new PolicyStore(storePrisma).publish({ tenant_id: TENANT, definition: permissivePackage(), published_by: SYSTEM });
  }, 180_000);

  afterAll(async () => {
    await docsPrisma?.$disconnect();
    await placementPrisma?.$disconnect();
    await storePrisma?.$disconnect();
    await admin?.end();
    await container?.stop();
  });

  it('seeds OFFER_LETTER and runs request→send while the Offer stays SENT (PL-1 evidence-only)', async () => {
    // An Offer in SENT (DRAFT → SENT via the governed transition).
    const offer = await offers.create({
      tenant_id: TENANT, submittal_id: uuid(), requisition_id: uuid(), talent_record_id: uuid(),
      actor_id: ACTOR, correlation_id: uuid(),
    });
    await offers.transition({ tenant_id: TENANT, id: offer.id, to_state: 'SENT', scopes: SCOPES, actor_id: ACTOR, correlation_id: uuid() });
    const beforeState = (await offers.findById(TENANT, offer.id))?.state;
    expect(beforeState).toBe('SENT');

    // request → the OFFER_LETTER Document + the three associations.
    const { document_id } = await orchestrator.request({ tenant_id: TENANT, offer_id: offer.id, created_by: ACTOR, requestId: uuid() });
    const doc = await admin.query(
      `SELECT document_type_id, status FROM "documents"."Document" WHERE id=$1 AND tenant_id=$2`,
      [document_id, TENANT],
    );
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0].document_type_id).toBe(OFFER_LETTER_TYPE_ID);
    expect(doc.rows[0].status).toBe('DRAFT');

    const assoc = await admin.query(
      `SELECT resource_type, resource_id, relationship FROM "documents"."DocumentAssociation" WHERE document_id=$1 ORDER BY resource_type`,
      [document_id],
    );
    const set = assoc.rows.map((r) => `${r.resource_type}/${r.relationship}:${r.resource_id}`);
    expect(set).toContain(`TALENT/SUBJECT:${offer.talent_record_id}`);
    expect(set).toContain(`OFFER/REGARDING:${offer.id}`);
    expect(set).toContain(`REQUISITION/REGARDING:${offer.requisition_id}`);

    // send → prepare + create/send envelope (stubbed seam), Talent resolved server-side.
    const sent = await orchestrator.send({ tenant_id: TENANT, document_id, offer_id: offer.id, created_by: ACTOR, requestId: uuid() });
    expect(sent.envelope_id).toBe('env-doc6-1');
    expect(sent.status).toBe('SENT');
    expect(createEnvelope).toHaveBeenCalledTimes(1);
    expect(sendEnvelope).toHaveBeenCalledTimes(1);
    // The signer was resolved server-side from the Offer's talent (never client-supplied).
    expect(talent.findById).toHaveBeenCalledWith({ tenant_id: TENANT, id: offer.talent_record_id });

    const prepared = await admin.query(`SELECT status FROM "documents"."Document" WHERE id=$1`, [document_id]);
    expect(prepared.rows[0].status).toBe('PREPARED');

    // PL-1 — the Offer's governed state is BYTE-UNCHANGED across request→send.
    const afterState = (await offers.findById(TENANT, offer.id))?.state;
    expect(afterState).toBe('SENT');

    // Derived status (PL-3) reads AWAITING_SIGNATURE off the PREPARED document.
    const status = await orchestrator.status(TENANT, document_id);
    expect(status.status).toBe('AWAITING_SIGNATURE');
    expect(status.document_status).toBe('PREPARED');
  });

  it('request throws DOCUMENT_NOT_FOUND for an unknown offer (no document created)', async () => {
    await expect(
      orchestrator.request({ tenant_id: TENANT, offer_id: uuid(), created_by: ACTOR, requestId: uuid() }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });
});
