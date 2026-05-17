import { describe, expect, it, vi } from 'vitest';

import type { IndeedSearchResultsRequestDto } from '../lib/dto/indeed-search-results-request.dto.js';
import {
  IngestionRepository,
  type RawPayloadRow,
} from '../lib/ingestion.repository.js';
import { IngestionService } from '../lib/ingestion.service.js';

const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const TALENT_ID = '01900000-0000-7000-8000-000000000010';
const NEW_PAYLOAD_ID = '01900000-0000-7000-8000-0000000000aa';
const EXISTING_PAYLOAD_ID = '01900000-0000-7000-8000-0000000000bb';
const FRESH_SHA = 'a'.repeat(64);

function makeRequest(
  overrides: Partial<IndeedSearchResultsRequestDto> = {},
): IndeedSearchResultsRequestDto {
  return {
    talent_id: TALENT_ID,
    storage_ref: 's3://aramo-raw-ingestion/tenant/indeed/shortlist-1.json',
    sha256: FRESH_SHA,
    content_type: 'application/json',
    captured_at: '2026-05-17T12:00:00.000Z',
    ...overrides,
  };
}

function makeRow(overrides: Partial<RawPayloadRow> = {}): RawPayloadRow {
  return {
    id: NEW_PAYLOAD_ID,
    tenant_id: TENANT_ID,
    source: 'indeed',
    storage_ref: 's3://aramo-raw-ingestion/tenant/indeed/shortlist-1.json',
    sha256: FRESH_SHA,
    content_type: 'application/json',
    captured_at: new Date('2026-05-17T12:00:00Z'),
    verified_email: null,
    profile_url: null,
    skill_surface_forms: null,
    created_at: new Date('2026-05-17T12:00:01Z'),
    updated_at: new Date('2026-05-17T12:00:01Z'),
    ...overrides,
  };
}

function makeRepoMock(): IngestionRepository {
  return {
    createPayload: vi.fn().mockResolvedValue(makeRow()),
    findBySha256: vi.fn().mockResolvedValue(null),
    findByVerifiedEmail: vi.fn().mockResolvedValue(null),
    findByProfileUrl: vi.fn().mockResolvedValue(null),
    findById: vi.fn(),
  } as unknown as IngestionRepository;
}

function makeSourceConsentMock(): { registerSourceDerivedConsent: ReturnType<typeof vi.fn> } {
  return { registerSourceDerivedConsent: vi.fn().mockResolvedValue(undefined) };
}

describe('IngestionService.acceptIndeedSearchResults — Phase 4 Group 3 Step 1', () => {
  it('writes RawPayloadReference with source=indeed and reports status=shortlisted_not_unlocked', async () => {
    const repo = makeRepoMock();
    const sourceConsent = makeSourceConsentMock();
    const service = new IngestionService(
      repo,
      sourceConsent as never,
    );

    const result = await service.acceptIndeedSearchResults({
      tenant_id: TENANT_ID,
      requestId: 'req-1',
      request: makeRequest(),
    });

    expect(repo.createPayload).toHaveBeenCalledOnce();
    const writeCall = (repo.createPayload as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writeCall.tenant_id).toBe(TENANT_ID);
    expect(writeCall.source).toBe('indeed');
    expect(writeCall.sha256).toBe(FRESH_SHA);

    expect(result.source).toBe('indeed');
    expect(result.status).toBe('shortlisted_not_unlocked');
    expect(result.dedup.match_signal).toBeNull();
  });

  it('NO contact data: verified_email and profile_url written as null (Phase 4 Step 1 "no contact data extracted")', async () => {
    const repo = makeRepoMock();
    const sourceConsent = makeSourceConsentMock();
    const service = new IngestionService(repo, sourceConsent as never);

    await service.acceptIndeedSearchResults({
      tenant_id: TENANT_ID,
      requestId: 'req-1',
      request: makeRequest(),
    });

    const writeCall = (repo.createPayload as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writeCall.verified_email).toBeNull();
    expect(writeCall.profile_url).toBeNull();
  });

  it('stores skill_surface_forms as opaque strings when supplied (no canonicalization, no skill_id)', async () => {
    const repo = makeRepoMock();
    const sourceConsent = makeSourceConsentMock();
    const service = new IngestionService(repo, sourceConsent as never);

    await service.acceptIndeedSearchResults({
      tenant_id: TENANT_ID,
      requestId: 'req-1',
      request: makeRequest({
        skill_surface_forms: ['TypeScript', 'React', 'PostgreSQL'],
      }),
    });

    const writeCall = (repo.createPayload as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writeCall.skill_surface_forms).toEqual([
      'TypeScript',
      'React',
      'PostgreSQL',
    ]);
  });

  // ===================================================================
  // R5 honest-visibility tripwire at the ingestion-seam level.
  //
  // The IngestionService must call SourceConsentService for Indeed
  // ingests. The SourceConsentService spec verifies the partial-
  // consent mapping; this spec verifies the seam is wired so
  // SourceConsentService is actually called with source='indeed'
  // on each Indeed ingest.
  // ===================================================================
  describe('R5 honest-visibility — source-consent registration on Indeed ingest', () => {
    it('calls SourceConsentService.registerSourceDerivedConsent with source=indeed for fresh ingests', async () => {
      const repo = makeRepoMock();
      const sourceConsent = makeSourceConsentMock();
      const service = new IngestionService(repo, sourceConsent as never);

      await service.acceptIndeedSearchResults({
        tenant_id: TENANT_ID,
        requestId: 'req-1',
        request: makeRequest(),
      });

      expect(sourceConsent.registerSourceDerivedConsent).toHaveBeenCalledOnce();
      const callArg = sourceConsent.registerSourceDerivedConsent.mock.calls[0][0];
      expect(callArg.source).toBe('indeed');
      expect(callArg.tenant_id).toBe(TENANT_ID);
      expect(callArg.talent_id).toBe(TALENT_ID);
    });

    it('does NOT re-register source-consent on a duplicate Indeed ingest (sha256 match)', async () => {
      const repo = makeRepoMock();
      const sourceConsent = makeSourceConsentMock();
      const existing = makeRow({ id: EXISTING_PAYLOAD_ID });
      (repo.findBySha256 as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      const service = new IngestionService(repo, sourceConsent as never);

      const result = await service.acceptIndeedSearchResults({
        tenant_id: TENANT_ID,
        requestId: 'req-1',
        request: makeRequest(),
      });

      expect(result.dedup.match_signal).toBe('sha256');
      expect(result.dedup.existing_payload_id).toBe(EXISTING_PAYLOAD_ID);
      // No new write; no re-registration of source-consent (the
      // original ingest already registered it).
      expect(repo.createPayload).not.toHaveBeenCalled();
      expect(sourceConsent.registerSourceDerivedConsent).not.toHaveBeenCalled();
    });
  });
});
