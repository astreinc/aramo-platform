import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../lib/prisma/prisma.service.js';
import { IngestionRepository } from '../lib/ingestion.repository.js';

const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const PAYLOAD_ID = '01900000-0000-7000-8000-0000000000aa';
const SHA = 'a'.repeat(64);

const ROW = {
  id: PAYLOAD_ID,
  tenant_id: TENANT_ID,
  source: 'talent_direct',
  storage_ref: 's3://aramo-raw-ingestion/tenant/source/payload.json',
  sha256: SHA,
  content_type: 'application/json',
  captured_at: new Date('2026-05-16T12:00:00Z'),
  verified_email: null,
  profile_url: null,
  source_class: 'SELF',
    declared_name: null,
  skill_surface_forms: null,
  created_at: new Date('2026-05-16T12:00:01Z'),
  updated_at: new Date('2026-05-16T12:00:01Z'),
};

function makePrisma(overrides: {
  create?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
  findFirst?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}): PrismaService {
  return {
    rawPayloadReference: {
      create: overrides.create ?? vi.fn(),
      findUnique: overrides.findUnique ?? vi.fn(),
      findFirst: overrides.findFirst ?? vi.fn(),
      update: overrides.update ?? vi.fn(),
    },
  } as unknown as PrismaService;
}

// TM-L1-B — the seven server-owned provenance-envelope columns. No post-create
// repository write path may include any of these in an UPDATE `data` payload;
// they are write-once at intake. This is the app-surface layer of a
// defence-in-depth: the DB boundary also rejects any envelope-column UPDATE via
// the raw_payload_reference_provenance immutability trigger (migration
// 20260909120000; proven in ingestion.integration.spec.ts).
const PROVENANCE_ENVELOPE_FIELDS = [
  'tenant_id',
  'source',
  'source_class',
  'storage_ref',
  'sha256',
  'content_type',
  'captured_at',
] as const;

describe('IngestionRepository.createPayload', () => {
  it('issues prisma.rawPayloadReference.create with the supplied fields', async () => {
    const create = vi.fn().mockResolvedValue(ROW);
    const repo = new IngestionRepository(makePrisma({ create }));

    await repo.createPayload({
      tenant_id: TENANT_ID,
      source: 'talent_direct',
      storage_ref: 's3://aramo-raw-ingestion/tenant/source/payload.json',
      sha256: SHA,
      content_type: 'application/json',
      captured_at: new Date('2026-05-16T12:00:00Z'),
      verified_email: null,
      profile_url: null,
      source_class: 'SELF',
    declared_name: null,
    });

    const writeCall = create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(writeCall.data['tenant_id']).toBe(TENANT_ID);
    expect(writeCall.data['source']).toBe('talent_direct');
    expect(writeCall.data['sha256']).toBe(SHA);
    // TR-2a-B1 — the server-derived attestation level is persisted on the row.
    expect(writeCall.data['source_class']).toBe('SELF');
    // The R10 structural guarantee (no R10-forbidden output fields on
    // the persistence model) is verified by ingestion.schema.spec.ts'
    // field-allowlist assertion. No runtime-level enumeration here.
  });

  it('passes through an explicit id when provided', async () => {
    const create = vi.fn().mockResolvedValue(ROW);
    const repo = new IngestionRepository(makePrisma({ create }));

    await repo.createPayload({
      id: PAYLOAD_ID,
      tenant_id: TENANT_ID,
      source: 'talent_direct',
      storage_ref: 's3://x/y',
      sha256: SHA,
      content_type: 'application/json',
      captured_at: new Date('2026-05-16T12:00:00Z'),
      verified_email: null,
      profile_url: null,
      source_class: 'SELF',
    declared_name: null,
    });

    const writeCall = create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(writeCall.data['id']).toBe(PAYLOAD_ID);
  });
});

describe('IngestionRepository.findBySha256', () => {
  it('queries the composite unique key (tenant_id, sha256)', async () => {
    const findUnique = vi.fn().mockResolvedValue(ROW);
    const repo = new IngestionRepository(makePrisma({ findUnique }));

    const result = await repo.findBySha256({
      tenant_id: TENANT_ID,
      sha256: SHA,
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        tenant_id_sha256: {
          tenant_id: TENANT_ID,
          sha256: SHA,
        },
      },
    });
    expect(result?.id).toBe(PAYLOAD_ID);
  });

  it('returns null when no row matches', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repo = new IngestionRepository(makePrisma({ findUnique }));

    const result = await repo.findBySha256({
      tenant_id: TENANT_ID,
      sha256: SHA,
    });
    expect(result).toBeNull();
  });
});

describe('IngestionRepository.findByVerifiedEmail', () => {
  it('queries scoped by tenant_id + verified_email; orders by created_at asc (earliest match wins)', async () => {
    const findFirst = vi.fn().mockResolvedValue(ROW);
    const repo = new IngestionRepository(makePrisma({ findFirst }));

    await repo.findByVerifiedEmail({
      tenant_id: TENANT_ID,
      verified_email: 'jane@example.com',
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenant_id: TENANT_ID,
        verified_email: 'jane@example.com',
      },
      orderBy: { created_at: 'asc' },
    });
  });
});

describe('IngestionRepository.findByProfileUrl', () => {
  it('queries scoped by tenant_id + profile_url; orders by created_at asc', async () => {
    const findFirst = vi.fn().mockResolvedValue(ROW);
    const repo = new IngestionRepository(makePrisma({ findFirst }));

    await repo.findByProfileUrl({
      tenant_id: TENANT_ID,
      profile_url: 'https://example.com/jane',
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenant_id: TENANT_ID,
        profile_url: 'https://example.com/jane',
      },
      orderBy: { created_at: 'asc' },
    });
  });
});

// TM-L1-B — the two post-create update paths touch ONLY their lifecycle column;
// neither may write any provenance-envelope field. This is the app-surface
// immutability wall: normalization/extraction/canonicalization cannot overwrite
// arrival provenance.
describe('IngestionRepository — post-create updates never mutate the provenance envelope', () => {
  it('markExtractionDone updates only extraction_done_at (no envelope field)', async () => {
    const update = vi.fn().mockResolvedValue(ROW);
    const repo = new IngestionRepository(makePrisma({ update }));

    await repo.markExtractionDone(PAYLOAD_ID);

    const call = update.mock.calls[0]?.[0] as { where: unknown; data: Record<string, unknown> };
    expect(call.where).toEqual({ id: PAYLOAD_ID });
    expect(Object.keys(call.data)).toEqual(['extraction_done_at']);
    for (const field of PROVENANCE_ENVELOPE_FIELDS) {
      expect(call.data).not.toHaveProperty(field);
    }
  });

  it('bumpExtractionAttempt updates only extraction_attempts (no envelope field)', async () => {
    const update = vi.fn().mockResolvedValue(ROW);
    const repo = new IngestionRepository(makePrisma({ update }));

    await repo.bumpExtractionAttempt(PAYLOAD_ID);

    const call = update.mock.calls[0]?.[0] as { where: unknown; data: Record<string, unknown> };
    expect(call.where).toEqual({ id: PAYLOAD_ID });
    expect(Object.keys(call.data)).toEqual(['extraction_attempts']);
    for (const field of PROVENANCE_ENVELOPE_FIELDS) {
      expect(call.data).not.toHaveProperty(field);
    }
  });
});
