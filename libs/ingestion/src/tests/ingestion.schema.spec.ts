import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Substrate-level structural checks (no DB required). Per PR-12
// directive §8 (the R10-clean acceptance criterion for the raw
// payload model and ingestion response schemas) + §7 (R10).

const SCHEMA_PATH = resolve(__dirname, '../../prisma/schema.prisma');

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, 'utf8');
}

function extractModelBlock(schema: string, modelName: string): string {
  const match = schema.match(
    new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (match === null || match[1] === undefined) {
    throw new Error(`model ${modelName} not found in schema.prisma`);
  }
  return match[1];
}

describe('RawPayloadReference schema — structural guarantees', () => {
  it('declares a RawPayloadReference model in libs/ingestion/prisma/schema.prisma', () => {
    expect(readSchema()).toMatch(/model\s+RawPayloadReference\s*\{/);
  });

  it('declares exactly the PR-12 directive §4.2 field set (no extras)', () => {
    // Positive assertion — the only field-declaration lines in the
    // RawPayloadReference block are the ones the PR-12 directive
    // §4.2 names. Catches both missing fields AND drift toward an
    // R10-forbidden output field on the data model.
    const block = extractModelBlock(readSchema(), 'RawPayloadReference');
    const fieldNames = block
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 && !line.startsWith('//') && !line.startsWith('@@'),
      )
      .map((line) => line.split(/\s+/)[0])
      .filter((name): name is string => name !== undefined && /^[a-z_]/.test(name));
    expect(fieldNames.sort()).toEqual(
      [
        'captured_at',
        'content_type',
        'created_at',
        'id',
        'profile_url',
        'sha256',
        'source',
        'storage_ref',
        'tenant_id',
        'updated_at',
        'verified_email',
      ].sort(),
    );
  });

  it('carries the (tenant_id, sha256) unique constraint (content-addressed idempotency)', () => {
    const block = extractModelBlock(readSchema(), 'RawPayloadReference');
    expect(block).toMatch(/@@unique\(\[tenant_id,\s*sha256\]\)/);
  });

  it('carries dedup-supporting indexes (tenant_id, verified_email) and (tenant_id, profile_url)', () => {
    const block = extractModelBlock(readSchema(), 'RawPayloadReference');
    expect(block).toMatch(/@@index\(\[tenant_id,\s*verified_email\]\)/);
    expect(block).toMatch(/@@index\(\[tenant_id,\s*profile_url\]\)/);
  });

  it('declares tenant_id as String @db.Uuid with no FK (cross-schema per Architecture v2.0 §7)', () => {
    const block = extractModelBlock(readSchema(), 'RawPayloadReference');
    expect(block).toMatch(/tenant_id\s+String\s+@db\.Uuid/);
    expect(block).not.toMatch(/tenant_id.*@relation/);
    expect(block).not.toMatch(/@relation\([^)]*tenant_id/);
  });

  it('schema.prisma declares the ingestion schema in datasource.schemas', () => {
    expect(readSchema()).toMatch(/schemas\s*=\s*\["ingestion"\]/);
  });
});

describe('PR-12 migration — structural guarantees', () => {
  function readMigrationSql(): string {
    const dir = resolve(__dirname, '../../prisma/migrations');
    const subdirs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /_init_ingestion_model$/.test(d.name))
      .map((d) => d.name)
      .sort();
    const initDir = subdirs[subdirs.length - 1];
    if (initDir === undefined) {
      throw new Error('init_ingestion_model migration directory not found');
    }
    return readFileSync(resolve(dir, initDir, 'migration.sql'), 'utf8');
  }

  it('creates the ingestion schema', () => {
    expect(readMigrationSql()).toMatch(
      /CREATE SCHEMA IF NOT EXISTS "ingestion"/,
    );
  });

  it('creates the RawPayloadReference table without any R10-forbidden output column', () => {
    const sql = readMigrationSql();
    const block = sql.match(
      /CREATE TABLE "ingestion"\."RawPayloadReference"[^;]+;/,
    )?.[0];
    expect(block).toBeDefined();
  });

  it('creates the (tenant_id, sha256) unique index', () => {
    expect(readMigrationSql()).toMatch(
      /CREATE UNIQUE INDEX "RawPayloadReference_tenant_id_sha256_key"/,
    );
  });

  it('creates the dedup-supporting indexes (verified_email, profile_url)', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(
      /CREATE INDEX "RawPayloadReference_tenant_id_verified_email_idx"/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "RawPayloadReference_tenant_id_profile_url_idx"/,
    );
  });

  it('adds NO foreign-key constraint on tenant_id (cross-schema reference, UUID-only per Architecture v2.0 §7)', () => {
    expect(readMigrationSql()).not.toMatch(/FOREIGN KEY \("tenant_id"\)/);
  });
});
