import { describe, expect, it, vi } from 'vitest';
import type { ResumeParserService } from '@aramo/resume-parse';
import type {
  ResumeDraftProposal,
  ResumeDraftResult,
  TalentExtractionService,
} from '@aramo/talent-extraction';

import { ResumeExtractionOrchestrator } from './resume-extraction.orchestrator.js';
import { ResumeSourceAuthorizer } from './resume-source-authorizer.js';
import type { ResumeAttachmentResolver } from './resume-source.types.js';

// TALENT-INTEL-1 (TI-1B) — the shared orchestrator. Proves: authorization
// precedes any storage access; both source forms dispatch through the single
// pipeline; exactly one governed model call; captured contact reaches prefill.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const DRAFT = '33333333-3333-4333-8333-333333333333';
const FILE_UUID = '44444444-4444-4444-8444-444444444444';
const ownTenantKey = `${TENANT_A}/talent/${DRAFT}/resume/${FILE_UUID}-Resume.pdf`;
const crossTenantKey = `${TENANT_B}/talent/${DRAFT}/resume/${FILE_UUID}-Resume.pdf`;
const CTX = { tenant_id: TENANT_A, requestId: 'req-1' };

function proposalWith(overrides: Partial<ResumeDraftProposal> = {}): ResumeDraftProposal {
  return {
    first_name: 'Alex',
    last_name: 'Chen',
    city: 'Herndon',
    state: 'Virginia',
    skills: [],
    work_history: [],
    education: [],
    certifications: [],
    rejected_count: 0,
    overflow: false,
    source_map_version: 'v1',
    resume_text_hash: 'abc123',
    ...overrides,
  };
}

function makeParser(text: string | null) {
  return {
    extractTextFromStorageKey: vi.fn().mockResolvedValue(text),
  } as unknown as ResumeParserService & {
    extractTextFromStorageKey: ReturnType<typeof vi.fn>;
  };
}

function makeExtraction(result: ResumeDraftResult) {
  return {
    extractResumeDraft: vi.fn().mockResolvedValue(result),
  } as unknown as TalentExtractionService & {
    extractResumeDraft: ReturnType<typeof vi.fn>;
  };
}

describe('ResumeExtractionOrchestrator', () => {
  it('CREATE own-tenant: runs the pipeline, one governed call, contact → prefill', async () => {
    const parser = makeParser('résumé text');
    const extraction = makeExtraction({
      status: 'success',
      proposal: proposalWith(),
      contact: { emails: ['alex@example.com'], phones: ['+1-703-555-0100'] },
    });
    const orchestrator = new ResumeExtractionOrchestrator(
      new ResumeSourceAuthorizer(),
      parser,
      extraction,
    );

    const res = await orchestrator.extractResume(
      { kind: 'CREATE_DRAFT_UPLOAD', storage_key: ownTenantKey },
      CTX,
    );

    // The authorized key (not a raw client key) reached storage.
    expect(parser.extractTextFromStorageKey).toHaveBeenCalledWith({
      storage_key: ownTenantKey,
      requestId: 'req-1',
    });
    // Exactly ONE governed model call.
    expect(extraction.extractResumeDraft).toHaveBeenCalledTimes(1);
    expect(res.mode).toBe('governed_llm');
    expect(res.parse_status).toBe('parsed');
    expect(res.prefill.first_name).toBe('Alex');
    expect(res.prefill.city).toBe('Herndon');
    // Captured (redaction-time) contact merged into prefill — no second scan.
    expect(res.prefill.email1).toBe('alex@example.com');
    expect(res.prefill.phone_cell).toBe('+1-703-555-0100');
  });

  it('CREATE cross-tenant: rejects BEFORE any object fetch (authorize-first)', async () => {
    const parser = makeParser('résumé text');
    const extraction = makeExtraction({ status: 'success', proposal: proposalWith() });
    const orchestrator = new ResumeExtractionOrchestrator(
      new ResumeSourceAuthorizer(),
      parser,
      extraction,
    );

    await expect(
      orchestrator.extractResume(
        { kind: 'CREATE_DRAFT_UPLOAD', storage_key: crossTenantKey },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'RESUME_SOURCE_UNAUTHORIZED', statusCode: 403 });

    // The security guarantee: storage was NEVER touched for a foreign key.
    expect(parser.extractTextFromStorageKey).not.toHaveBeenCalled();
    expect(extraction.extractResumeDraft).not.toHaveBeenCalled();
  });

  it('ATTACHMENT: resolves the owned storage_key via the port, then extracts', async () => {
    const resolver: ResumeAttachmentResolver = {
      resolveOwnedResumeStorageKey: vi
        .fn()
        .mockResolvedValue({ storage_key: 'tenantA/talent/tal-1/resume/xyz-CV.pdf' }),
    };
    const parser = makeParser('résumé text');
    const extraction = makeExtraction({ status: 'success', proposal: proposalWith() });
    const orchestrator = new ResumeExtractionOrchestrator(
      new ResumeSourceAuthorizer(resolver),
      parser,
      extraction,
    );

    await orchestrator.extractResume(
      { kind: 'ATTACHMENT', attachment_id: 'att-1', talent_id: 'tal-1' },
      CTX,
    );

    expect(resolver.resolveOwnedResumeStorageKey).toHaveBeenCalledOnce();
    // The orchestrator fetched the RESOLVER'S key, never a client-supplied key.
    expect(parser.extractTextFromStorageKey).toHaveBeenCalledWith({
      storage_key: 'tenantA/talent/tal-1/resume/xyz-CV.pdf',
      requestId: 'req-1',
    });
  });

  it('propagates an explicit provider failure as an honest status (no masked draft)', async () => {
    const parser = makeParser('résumé text');
    const extraction = makeExtraction({
      status: 'provider_truncated',
      proposal: proposalWith(),
    });
    const orchestrator = new ResumeExtractionOrchestrator(
      new ResumeSourceAuthorizer(),
      parser,
      extraction,
    );

    const res = await orchestrator.extractResume(
      { kind: 'CREATE_DRAFT_UPLOAD', storage_key: ownTenantKey },
      CTX,
    );
    expect(res.parse_status).toBe('failed');
    expect(res.extraction_status).toBe('provider_truncated');
    expect(res.prefill).toEqual({});
  });
});
