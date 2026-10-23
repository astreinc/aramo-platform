import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IntelligencePrismaService } from '../index.js';

// ATI-SEP-1 T0 — the TI migration set on a real PostgreSQL 17, in a database
// named aramo_intelligence (ADR-0036 Decision 2), plus a PrismaService ping.

const MIGRATIONS = resolve(__dirname, '../../prisma/migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(MIGRATIONS, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('intelligence schema — own database', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: IntelligencePrismaService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).withDatabase('aramo_intelligence').start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const f of migrationFiles()) await db.query(readFileSync(f, 'utf8'));
    prisma = new IntelligencePrismaService(container.getConnectionUri());
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('creates only the intelligence schema with the T0 baseline row', async () => {
    const schemas = await db.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('public','information_schema') AND schema_name NOT LIKE 'pg_%'`,
    );
    expect(schemas.rows.map((r) => r.schema_name)).toEqual(['intelligence']);
    const row = await db.query(`SELECT value FROM "intelligence"."ServiceInfo" WHERE key = 'schema_baseline'`);
    expect(row.rows[0]?.value).toBe('ATI-SEP-1-T0');
  });

  it('IntelligencePrismaService pings and reads through the generated client', async () => {
    await expect(prisma.ping()).resolves.toBe(true);
    const info = await prisma.serviceInfo.findUnique({ where: { key: 'schema_baseline' } });
    expect(info?.value).toBe('ATI-SEP-1-T0');
  });
});
