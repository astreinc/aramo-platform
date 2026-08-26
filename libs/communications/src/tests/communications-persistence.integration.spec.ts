import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommunicationsRepository } from '../lib/communications.repository.js';
import { CommunicationsService } from '../lib/communications.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { CommunicationInvalidStateError } from '../lib/domain/errors.js';
import { FakeVoiceProvider } from '../lib/provider/fake/fake-voice-provider.js';

// COMM-B1 — persistence proofs against real Postgres 17. Skipped unless
// ARAMO_RUN_INTEGRATION=1. The communications schema is self-contained
// (cross-schema refs are UUID-only, no FK), so this spec globs ONLY the
// module's own migrations — no curated cross-lib migration list.

const ROOT = resolve(__dirname, '../../../..');

function communicationsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/communications/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'COMM-B1 communications persistence — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let repo: CommunicationsRepository;
    let service: CommunicationsService;

    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();
    const CONNECTION = randomUUID();
    const RECRUITER = randomUUID();

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of communicationsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new CommunicationsRepository(prisma);
      service = new CommunicationsService(repo);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    function newOutbound(tenant: string) {
      return service.createOutboundInteraction({
        tenant_id: tenant,
        integration_connection_id: CONNECTION,
        channel: 'voice',
        from_address: '+15715550100',
        to_address: '+17035550111',
        initiated_by_id: RECRUITER,
      });
    }

    it('persists a CommunicationInteraction as system of record; provider ids are NOT the identity', async () => {
      const intx = await newOutbound(TENANT_A);
      expect(intx.status).toBe('created');
      // Canonical identity is a UUID; no provider id is set at creation.
      expect(intx.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(intx.provider_call_id).toBeNull();
      expect(intx.provider_call_element_id).toBeNull();
    });

    it('legal transitions persist with lifecycle timestamps; illegal transition throws', async () => {
      const intx = await newOutbound(TENANT_A);
      const initiated = await service.transition(TENANT_A, intx.id, 'initiated');
      expect(initiated.status).toBe('initiated');
      expect(initiated.started_at).not.toBeNull();

      const ringing = await service.transition(TENANT_A, intx.id, 'ringing');
      expect(ringing.status).toBe('ringing');
      expect(ringing.ringing_at).not.toBeNull();

      const connected = await service.transition(TENANT_A, intx.id, 'connected');
      expect(connected.status).toBe('connected');
      expect(connected.connected_at).not.toBeNull();

      const completed = await service.transition(TENANT_A, intx.id, 'completed', {
        duration_seconds: 872,
      });
      expect(completed.status).toBe('completed');
      expect(completed.ended_at).not.toBeNull();
      expect(completed.duration_seconds).toBe(872);

      // completed is terminal — any further transition is illegal.
      await expect(service.transition(TENANT_A, intx.id, 'initiated')).rejects.toBeInstanceOf(
        CommunicationInvalidStateError,
      );
    });

    it('rejects a skip transition (created -> connected) without mutating state', async () => {
      const intx = await newOutbound(TENANT_A);
      await expect(service.transition(TENANT_A, intx.id, 'connected')).rejects.toBeInstanceOf(
        CommunicationInvalidStateError,
      );
      const still = await repo.findInteractionForTenant(TENANT_A, intx.id);
      expect(still?.status).toBe('created');
    });

    it('tenant isolation: tenant B cannot read or transition tenant A\'s interaction', async () => {
      const intx = await newOutbound(TENANT_A);
      expect(await repo.findInteractionForTenant(TENANT_B, intx.id)).toBeNull();
      // A cross-tenant transition is tenant-safe NOT FOUND, never a state change.
      await expect(service.transition(TENANT_B, intx.id, 'initiated')).rejects.toThrowError(
        /not found/i,
      );
      const untouched = await repo.findInteractionForTenant(TENANT_A, intx.id);
      expect(untouched?.status).toBe('created');
    });

    it('tenant isolation: cross-tenant association write is refused', async () => {
      const intx = await newOutbound(TENANT_A);
      await expect(
        service.associate({
          tenant_id: TENANT_B,
          interaction_id: intx.id,
          subject_type: 'talent_record',
          subject_id: randomUUID(),
          relation_type: 'subject',
        }),
      ).rejects.toThrowError(/not found/i);
    });

    it('associates Talent (subject) and requisition (regarding); requisition context is optional', async () => {
      const intx = await newOutbound(TENANT_A);
      const talent = randomUUID();
      const requisition = randomUUID();
      await service.associate({
        tenant_id: TENANT_A,
        interaction_id: intx.id,
        subject_type: 'talent_record',
        subject_id: talent,
        relation_type: 'subject',
      });
      await service.associate({
        tenant_id: TENANT_A,
        interaction_id: intx.id,
        subject_type: 'requisition',
        subject_id: requisition,
        relation_type: 'regarding',
      });
      const forTalent = await repo.listInteractionIdsForSubject(TENANT_A, 'talent_record', talent);
      const forReq = await repo.listInteractionIdsForSubject(TENANT_A, 'requisition', requisition);
      expect(forTalent).toContain(intx.id);
      expect(forReq).toContain(intx.id); // one call on both timelines
    });

    it('records a disposition from the locked vocabulary with notes', async () => {
      const intx = await newOutbound(TENANT_A);
      await service.dispose({
        tenant_id: TENANT_A,
        interaction_id: intx.id,
        disposition: 'left_voicemail',
        notes: 'called after hours',
        dispositioned_by_id: RECRUITER,
      });
      const dispositions = await repo.listDispositions(TENANT_A, intx.id);
      expect(dispositions).toHaveLength(1);
      expect(dispositions[0]?.disposition).toBe('left_voicemail');
    });

    it('provider-event inbox is idempotent by UNIQUE(tenant, connection, event_key)', async () => {
      const key = `evt-${randomUUID()}`;
      const first = await repo.recordProviderEvent({
        tenant_id: TENANT_A,
        integration_connection_id: CONNECTION,
        provider_event_key: key,
        event_type: 'call.completed',
      });
      const second = await repo.recordProviderEvent({
        tenant_id: TENANT_A,
        integration_connection_id: CONNECTION,
        provider_event_key: key,
        event_type: 'call.completed',
      });
      expect(first.reserved).toBe(true);
      expect(second.reserved).toBe(false); // redelivery is a no-op
      expect(second.row.id).toBe(first.row.id); // converged on the same row
    });

    it('correlation lookup is tenant+connection scoped (provider id is metadata, never global)', async () => {
      const intx = await newOutbound(TENANT_A);
      const element = `elem-${randomUUID()}`;
      // Drive the fake provider -> normalized event -> canonical transition.
      const fake = new FakeVoiceProvider();
      const normalized = await fake.normalizeWebhook({
        provider_event_key: `k-${element}`,
        event_type: 'call.ringing',
        target_status: 'ringing',
        provider_call_element_id: element,
      });
      await service.transition(TENANT_A, intx.id, 'initiated');
      await service.transition(TENANT_A, intx.id, normalized.target_status, {
        provider_call_element_id: normalized.provider_call_element_id,
      });

      const foundA = await repo.findInteractionByProviderCallElement(TENANT_A, CONNECTION, element);
      expect(foundA?.id).toBe(intx.id);
      // Same provider id under a different tenant does NOT match.
      const foundB = await repo.findInteractionByProviderCallElement(TENANT_B, CONNECTION, element);
      expect(foundB).toBeNull();
    });

    it('maps a recruiter provider identity, unique per (connection, recruiter)', async () => {
      await repo.mapProviderIdentity({
        tenant_id: TENANT_A,
        integration_connection_id: CONNECTION,
        recruiter_id: RECRUITER,
        provider_user_id: 'pv-user-1',
        voice_enabled: true,
      });
      const found = await repo.findProviderIdentityForRecruiter(TENANT_A, CONNECTION, RECRUITER);
      expect(found?.provider_user_id).toBe('pv-user-1');
      expect(found?.status).toBe('active');
      // A duplicate mapping for the same (connection, recruiter) is rejected.
      await expect(
        repo.mapProviderIdentity({
          tenant_id: TENANT_A,
          integration_connection_id: CONNECTION,
          recruiter_id: RECRUITER,
          provider_user_id: 'pv-user-2',
        }),
      ).rejects.toBeTruthy();
    });

    it('structural: the communications schema stores NO raw payload blob (R-COMM-RAW-PAYLOAD)', async () => {
      // No JSONB column anywhere in the schema — no raw provider payload/credential.
      const jsonb = await db.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'communications' AND data_type = 'jsonb'`,
      );
      expect(jsonb.rowCount).toBe(0);
      // The only payload-ish column is payload_reference, and it is opaque text.
      const payloadCols = await db.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'communications' AND column_name LIKE '%payload%'`,
      );
      expect(payloadCols.rows).toEqual([
        { column_name: 'payload_reference', data_type: 'text' },
      ]);
      // No column named like a secret/credential exists.
      const secrets = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'communications'
           AND (column_name LIKE '%secret%' OR column_name LIKE '%credential%'
                OR column_name LIKE '%token%' OR column_name LIKE '%password%')`,
      );
      expect(secrets.rowCount).toBe(0);
    });
  },
);
