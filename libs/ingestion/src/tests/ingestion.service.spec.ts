import { describe, expect, it, vi } from 'vitest';

import type { IngestionPayloadRequestDto } from '../lib/dto/ingestion-payload-request.dto.js';
import {
  IngestionRepository,
  type RawPayloadRow,
} from '../lib/ingestion.repository.js';
import { IngestionService } from '../lib/ingestion.service.js';

const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_B = '01900000-0000-7000-8000-000000000002';
const NEW_PAYLOAD_ID = '01900000-0000-7000-8000-0000000000aa';
const EXISTING_PAYLOAD_ID = '01900000-0000-7000-8000-0000000000bb';

const FRESH_SHA = 'a'.repeat(64);
const DUP_SHA = 'b'.repeat(64);

function makeRequest(
  overrides: Partial<IngestionPayloadRequestDto> = {},
): IngestionPayloadRequestDto {
  return {
    source: 'talent_direct',
    storage_ref: 's3://aramo-raw-ingestion/tenant/source/payload.json',
    sha256: FRESH_SHA,
    content_type: 'application/json',
    captured_at: '2026-05-16T12:00:00.000Z',
    ...overrides,
  };
}

function makeRow(overrides: Partial<RawPayloadRow> = {}): RawPayloadRow {
  return {
    id: NEW_PAYLOAD_ID,
    tenant_id: TENANT_ID,
    source: 'talent_direct',
    storage_ref: 's3://aramo-raw-ingestion/tenant/source/payload.json',
    sha256: FRESH_SHA,
    content_type: 'application/json',
    captured_at: new Date('2026-05-16T12:00:00Z'),
    verified_email: null,
    profile_url: null,
    skill_surface_forms: null,
    created_at: new Date('2026-05-16T12:00:01Z'),
    updated_at: new Date('2026-05-16T12:00:01Z'),
    ...overrides,
  };
}

function makeRepoMock(): IngestionRepository {
  return {
    createPayload: vi.fn(),
    findBySha256: vi.fn().mockResolvedValue(null),
    findByVerifiedEmail: vi.fn().mockResolvedValue(null),
    findByProfileUrl: vi.fn().mockResolvedValue(null),
    findById: vi.fn(),
  } as unknown as IngestionRepository;
}

// No-op SourceConsentService stub — the generic /payloads endpoint
// tests (this file) do not exercise the Indeed path. PR-13 added
// SourceConsentService as a constructor dependency; the generic
// endpoint never calls it. The Indeed-side R5 honest-visibility
// assertions live in indeed.service.spec.ts.
function makeSourceConsentStub(): never {
  return {
    registerSourceDerivedConsent: vi.fn().mockResolvedValue(undefined),
  } as never;
}

describe('IngestionService.acceptPayload — accept (fresh)', () => {
  it('stores a new payload when no prior match exists; reports status=accepted, dedup match_signal=null', async () => {
    const repo = makeRepoMock();
    (repo.createPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow(),
    );
    const service = new IngestionService(repo, makeSourceConsentStub());

    const result = await service.acceptPayload({
      tenant_id: TENANT_ID,
      request: makeRequest(),
    });

    expect(repo.findBySha256).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      sha256: FRESH_SHA,
    });
    expect(repo.createPayload).toHaveBeenCalledOnce();
    expect(result.status).toBe('accepted');
    expect(result.dedup.match_signal).toBeNull();
    expect(result.dedup.existing_payload_id).toBeNull();
    expect(result.id).toBe(NEW_PAYLOAD_ID);
    expect(result.tenant_id).toBe(TENANT_ID);
    expect(result.source).toBe('talent_direct');
  });

  it('normalizes verified_email (trim + lowercase) before storage and matching', async () => {
    const repo = makeRepoMock();
    (repo.createPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow({ verified_email: 'jane@example.com' }),
    );
    const service = new IngestionService(repo, makeSourceConsentStub());

    await service.acceptPayload({
      tenant_id: TENANT_ID,
      request: makeRequest({ verified_email: '  Jane@Example.COM  ' }),
    });

    expect(repo.findByVerifiedEmail).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      verified_email: 'jane@example.com',
    });
    const writeCall = (repo.createPayload as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(writeCall.verified_email).toBe('jane@example.com');
  });

  it('normalizes profile_url (trim only — URL paths can be case-significant)', async () => {
    const repo = makeRepoMock();
    (repo.createPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow({ profile_url: 'https://example.com/Profile/123' }),
    );
    const service = new IngestionService(repo, makeSourceConsentStub());

    await service.acceptPayload({
      tenant_id: TENANT_ID,
      request: makeRequest({
        profile_url: '  https://example.com/Profile/123  ',
      }),
    });

    expect(repo.findByProfileUrl).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      profile_url: 'https://example.com/Profile/123',
    });
  });
});

describe('IngestionService.acceptPayload — dedup by sha256 (content addressing)', () => {
  it('returns status=duplicate with match_signal=sha256 when the same payload bytes exist in this tenant', async () => {
    const repo = makeRepoMock();
    const existing = makeRow({
      id: EXISTING_PAYLOAD_ID,
      sha256: FRESH_SHA,
    });
    (repo.findBySha256 as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    const service = new IngestionService(repo, makeSourceConsentStub());

    const result = await service.acceptPayload({
      tenant_id: TENANT_ID,
      request: makeRequest(),
    });

    expect(result.status).toBe('duplicate');
    expect(result.dedup.match_signal).toBe('sha256');
    expect(result.dedup.existing_payload_id).toBe(EXISTING_PAYLOAD_ID);
    // Detection-and-flag only: NO new row written when a duplicate is detected.
    expect(repo.createPayload).not.toHaveBeenCalled();
  });
});

describe('IngestionService.acceptPayload — dedup by verified_email', () => {
  it('returns status=duplicate with match_signal=verified_email when prior payload shares the email in this tenant', async () => {
    const repo = makeRepoMock();
    const existing = makeRow({
      id: EXISTING_PAYLOAD_ID,
      sha256: DUP_SHA,
      verified_email: 'jane@example.com',
    });
    (repo.findByVerifiedEmail as ReturnType<typeof vi.fn>).mockResolvedValue(
      existing,
    );
    const service = new IngestionService(repo, makeSourceConsentStub());

    const result = await service.acceptPayload({
      tenant_id: TENANT_ID,
      request: makeRequest({ verified_email: 'jane@example.com' }),
    });

    expect(result.status).toBe('duplicate');
    expect(result.dedup.match_signal).toBe('verified_email');
    expect(result.dedup.existing_payload_id).toBe(EXISTING_PAYLOAD_ID);
    expect(repo.createPayload).not.toHaveBeenCalled();
  });
});

describe('IngestionService.acceptPayload — dedup by profile_url', () => {
  it('returns status=duplicate with match_signal=profile_url when prior payload shares the URL in this tenant', async () => {
    const repo = makeRepoMock();
    const existing = makeRow({
      id: EXISTING_PAYLOAD_ID,
      sha256: DUP_SHA,
      profile_url: 'https://example.com/jane',
    });
    (repo.findByProfileUrl as ReturnType<typeof vi.fn>).mockResolvedValue(
      existing,
    );
    const service = new IngestionService(repo, makeSourceConsentStub());

    const result = await service.acceptPayload({
      tenant_id: TENANT_ID,
      request: makeRequest({ profile_url: 'https://example.com/jane' }),
    });

    expect(result.status).toBe('duplicate');
    expect(result.dedup.match_signal).toBe('profile_url');
    expect(result.dedup.existing_payload_id).toBe(EXISTING_PAYLOAD_ID);
    expect(repo.createPayload).not.toHaveBeenCalled();
  });
});

describe('IngestionService.acceptPayload — tenant scoping (R5 honest-visibility)', () => {
  it('queries dedup paths scoped by tenant_id from authContext (never body)', async () => {
    const repo = makeRepoMock();
    (repo.createPayload as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow({ tenant_id: TENANT_B }),
    );
    const service = new IngestionService(repo, makeSourceConsentStub());

    await service.acceptPayload({
      tenant_id: TENANT_B,
      request: makeRequest(),
    });

    expect(repo.findBySha256).toHaveBeenCalledWith({
      tenant_id: TENANT_B,
      sha256: FRESH_SHA,
    });
    const writeCall = (repo.createPayload as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(writeCall.tenant_id).toBe(TENANT_B);
  });
});

describe('IngestionService dedup order (sha256 wins; signals do not aggregate)', () => {
  it('returns sha256 match when both sha256 and verified_email would match (sha256 is checked first)', async () => {
    const repo = makeRepoMock();
    const shaExisting = makeRow({
      id: EXISTING_PAYLOAD_ID,
      sha256: FRESH_SHA,
    });
    (repo.findBySha256 as ReturnType<typeof vi.fn>).mockResolvedValue(
      shaExisting,
    );
    // findByVerifiedEmail should not be reached
    const service = new IngestionService(repo, makeSourceConsentStub());

    const result = await service.acceptPayload({
      tenant_id: TENANT_ID,
      request: makeRequest({ verified_email: 'jane@example.com' }),
    });

    expect(result.dedup.match_signal).toBe('sha256');
    expect(repo.findByVerifiedEmail).not.toHaveBeenCalled();
  });
});
