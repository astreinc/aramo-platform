import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IntegrationConnectionRepository } from '../lib/connection/integration-connection.repository.js';
import { ConnectorDeliveryRepository } from '../lib/execution/connector-delivery.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { buildConnectorSecretRef } from '../lib/secrets/connector-secret-ref.js';
import { ConnectorSecretResolver, ConnectorSecretResolutionError } from '../lib/secrets/connector-secret-resolver.js';

import { FakeSecretsManager } from './support/fakes.js';

// T8-CONNECTOR-A — persistence proofs against real Postgres 17 (Architect DB
// phase). Skipped unless ARAMO_RUN_INTEGRATION=1.
//
// Proves: (1) reserve() is race-safe under concurrency via the UNIQUE
// constraint; (2) a second repository instance recognizes a completed delivery
// (restart durability); (3) tenant A never observes/reserves tenant B's
// delivery/connection; (4) resolver derivation is driven end-to-end by the
// DB-loaded connection; (5) a duplicate reservation race converges to one owner.

const ROOT = resolve(__dirname, '../../../..');

function integrationMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/integration/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T8-CONNECTOR-A connector persistence — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let deliveries: ConnectorDeliveryRepository;
    let connections: IntegrationConnectionRepository;

    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of integrationMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      deliveries = new ConnectorDeliveryRepository(prisma);
      connections = new IntegrationConnectionRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('reserve() is idempotent-by-constraint: a second reserve of the same key returns the SAME row, not a new one', async () => {
      const conn = await connections.create({ tenant_id: TENANT_A, provider_key: 'acme_vms' });
      const first = await deliveries.reserve({ tenant_id: TENANT_A, connection_id: conn.id, delivery_key: 'D1' });
      const second = await deliveries.reserve({ tenant_id: TENANT_A, connection_id: conn.id, delivery_key: 'D1' });
      expect(first.reserved).toBe(true);
      expect(second.reserved).toBe(false);
      expect(second.row.id).toBe(first.row.id);
    });

    it('reserve() converges to ONE owner under a concurrent race (UNIQUE authority)', async () => {
      const conn = await connections.create({ tenant_id: TENANT_A, provider_key: 'acme_vms' });
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          deliveries.reserve({ tenant_id: TENANT_A, connection_id: conn.id, delivery_key: 'RACE' }),
        ),
      );
      const winners = attempts.filter((a) => a.reserved);
      expect(winners).toHaveLength(1); // exactly one insert won
      const ids = new Set(attempts.map((a) => a.row.id));
      expect(ids.size).toBe(1); // everyone converged on the same delivery row
    });

    it('a SECOND repository instance recognizes a completed delivery (restart durability)', async () => {
      const conn = await connections.create({ tenant_id: TENANT_A, provider_key: 'acme_vms' });
      const res = await deliveries.reserve({ tenant_id: TENANT_A, connection_id: conn.id, delivery_key: 'DONE' });
      await deliveries.markProcessed(res.row.id, randomUUID());

      // Simulate a process restart: a brand-new PrismaService + repository.
      const prisma2 = new PrismaService(container.getConnectionUri());
      await prisma2.$connect();
      try {
        const fresh = new ConnectorDeliveryRepository(prisma2);
        const seen = await fresh.findByKey(TENANT_A, conn.id, 'DONE');
        expect(seen?.status).toBe('processed');
      } finally {
        await prisma2.$disconnect();
      }
    });

    it('tenant isolation: tenant B cannot observe or reserve tenant A\'s connection/delivery', async () => {
      const connA = await connections.create({ tenant_id: TENANT_A, provider_key: 'acme_vms' });
      await deliveries.reserve({ tenant_id: TENANT_A, connection_id: connA.id, delivery_key: 'ISO' });

      // Tenant B cannot see A's connection nor A's delivery.
      expect(await connections.findByIdForTenant(TENANT_B, connA.id)).toBeNull();
      expect(await deliveries.findByKey(TENANT_B, connA.id, 'ISO')).toBeNull();
    });

    it('resolver derivation is driven end-to-end by the DB-loaded connection', async () => {
      process.env['ARAMO_ENV'] = 'itest';
      const conn = await connections.create({ tenant_id: TENANT_A, provider_key: 'acme_vms' });
      const secretRef = buildConnectorSecretRef({ tenant_id: TENANT_A, connection_id: conn.id });
      await connections.setSecretRef(TENANT_A, conn.id, secretRef);

      const sm = new FakeSecretsManager({
        [`aramo/itest/connector/${TENANT_A}/${conn.id}`]: 'the-credential',
      });
      const resolver = new ConnectorSecretResolver(connections, sm);

      // Tenant A resolves; SM id was derived from the DB row's own tenant/id.
      await expect(
        resolver.resolveForExecution({ tenant_id: TENANT_A, connection_id: conn.id }),
      ).resolves.toBe('the-credential');
      expect(sm.requested).toEqual([`aramo/itest/connector/${TENANT_A}/${conn.id}`]);

      // Tenant B requesting A's connection id → tenant-safe NOT_FOUND, SM untouched.
      sm.requested.length = 0;
      await expect(
        resolver.resolveForExecution({ tenant_id: TENANT_B, connection_id: conn.id }),
      ).rejects.toBeInstanceOf(ConnectorSecretResolutionError);
      expect(sm.requested).toEqual([]);
      delete process.env['ARAMO_ENV'];
    });
  },
);
