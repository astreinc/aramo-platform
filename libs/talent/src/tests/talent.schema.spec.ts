import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Substrate-level structural checks (no DB required). Per PR-10 directive
// §10 ("Talent tenant-agnostic verification: the Talent model has no
// tenant_id column") and §4.4 (the deferred overlay field stays out of
// product source).

const SCHEMA_PATH = resolve(__dirname, '../../prisma/schema.prisma');

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, 'utf8');
}

function extractModelBlock(schema: string, modelName: string): string {
  const match = schema.match(new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (match === null || match[1] === undefined) {
    throw new Error(`model ${modelName} not found in schema.prisma`);
  }
  return match[1];
}

describe('Talent core schema — tenant-agnostic structural guarantee', () => {
  it('declares a Talent model in libs/talent/prisma/schema.prisma', () => {
    const schema = readSchema();
    expect(schema).toMatch(/model\s+Talent\s*\{/);
  });

  it('declares a TalentTenantOverlay model in libs/talent/prisma/schema.prisma', () => {
    const schema = readSchema();
    expect(schema).toMatch(/model\s+TalentTenantOverlay\s*\{/);
  });

  it('Talent model has NO tenant_id field (tenant-agnostic core)', () => {
    const talentBlock = extractModelBlock(readSchema(), 'Talent');
    // \btenant_id\b in the Talent block (not the file) catches the field
    // as a column declaration without false-matching the overlay relation.
    expect(talentBlock).not.toMatch(/\btenant_id\b/);
  });

  it('TalentTenantOverlay carries tenant_id as String @db.Uuid with NO FK relation', () => {
    const overlayBlock = extractModelBlock(readSchema(), 'TalentTenantOverlay');
    expect(overlayBlock).toMatch(/tenant_id\s+String\s+@db\.Uuid/);
    // The only @relation in the overlay block must be the intra-schema
    // Talent FK; no @relation should reference tenant_id.
    expect(overlayBlock).not.toMatch(/tenant_id.*@relation/);
    expect(overlayBlock).not.toMatch(/@relation\([^)]*tenant_id/);
  });

  it('TalentTenantOverlay has the @@unique([talent_id, tenant_id]) constraint', () => {
    const overlayBlock = extractModelBlock(readSchema(), 'TalentTenantOverlay');
    expect(overlayBlock).toMatch(/@@unique\(\[talent_id,\s*tenant_id\]\)/);
  });

  it('TalentTenantOverlay has the @@index([tenant_id]) constraint', () => {
    const overlayBlock = extractModelBlock(readSchema(), 'TalentTenantOverlay');
    expect(overlayBlock).toMatch(/@@index\(\[tenant_id\]\)/);
  });

  it('TalentTenantOverlay declares the FK relation to Talent via talent_id', () => {
    const overlayBlock = extractModelBlock(readSchema(), 'TalentTenantOverlay');
    expect(overlayBlock).toMatch(
      /talent\s+Talent\s+@relation\(fields:\s*\[talent_id\],\s*references:\s*\[id\]\)/,
    );
  });

  it('schema.prisma carries the talent schema in datasource.schemas', () => {
    const schema = readSchema();
    expect(schema).toMatch(/schemas\s*=\s*\["talent"\]/);
  });

  it('TalentTenantOverlay declares exactly the PR-10 directive §4.2 field set (deferred field absent)', () => {
    // Positive assertion: the only field-declaration lines in the
    // overlay block are the ones the PR-10 directive §4.2 names. This
    // verifies the §4.4 deferral structurally without naming the
    // deferred token in product source.
    const overlayBlock = extractModelBlock(readSchema(), 'TalentTenantOverlay');
    const fieldNames = overlayBlock
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('@@'))
      .map((line) => line.split(/\s+/)[0])
      .filter((name): name is string => name !== undefined && /^[a-z_]/.test(name));
    expect(fieldNames.sort()).toEqual(
      [
        'created_at',
        'id',
        'source_channel',
        'source_recruiter_id',
        'talent',
        'talent_id',
        'tenant_id',
        'tenant_status',
        'updated_at',
      ].sort(),
    );
  });
});

describe('PR-10 migration — structural guarantees', () => {
  function readMigrationSql(): string {
    const dir = resolve(__dirname, '../../prisma/migrations');
    const subdirs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /_init_talent_model$/.test(d.name))
      .map((d) => d.name)
      .sort();
    const initDir = subdirs[subdirs.length - 1];
    if (initDir === undefined) {
      throw new Error('init_talent_model migration directory not found');
    }
    return readFileSync(resolve(dir, initDir, 'migration.sql'), 'utf8');
  }

  it('creates the talent schema', () => {
    expect(readMigrationSql()).toMatch(/CREATE SCHEMA IF NOT EXISTS "talent"/);
  });

  it('creates the Talent table WITHOUT a tenant_id column', () => {
    const sql = readMigrationSql();
    const block = sql.match(/CREATE TABLE "talent"\."Talent"[^;]+;/)?.[0];
    expect(block).toBeDefined();
    expect(block).not.toMatch(/\btenant_id\b/);
  });

  it('creates the TalentTenantOverlay table with tenant_id UUID NOT NULL', () => {
    const sql = readMigrationSql();
    const block = sql.match(/CREATE TABLE "talent"\."TalentTenantOverlay"[^;]+;/)?.[0];
    expect(block).toBeDefined();
    expect(block).toMatch(/"tenant_id"\s+UUID\s+NOT\s+NULL/);
  });

  it('creates the @@unique([talent_id, tenant_id]) index', () => {
    expect(readMigrationSql()).toMatch(
      /CREATE UNIQUE INDEX "TalentTenantOverlay_talent_id_tenant_id_key"/,
    );
  });

  it('creates the @@index([tenant_id]) index', () => {
    expect(readMigrationSql()).toMatch(/CREATE INDEX "TalentTenantOverlay_tenant_id_idx"/);
  });

  it('adds the FK constraint TalentTenantOverlay.talent_id → Talent.id', () => {
    expect(readMigrationSql()).toMatch(
      /ALTER TABLE "talent"\."TalentTenantOverlay" ADD CONSTRAINT "TalentTenantOverlay_talent_id_fkey" FOREIGN KEY \("talent_id"\) REFERENCES "talent"\."Talent"\("id"\)/,
    );
  });

  it('does NOT add a FK on tenant_id (cross-schema reference, UUID-only per Architecture v2.0 §7)', () => {
    expect(readMigrationSql()).not.toMatch(
      /FOREIGN KEY \("tenant_id"\)/,
    );
  });
});
