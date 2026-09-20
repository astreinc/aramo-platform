import { describe, expect, it, vi } from 'vitest';

import { ResumeExtractionDraftProcessor } from '../lib/resume-extraction-draft/resume-extraction-draft.processor.js';

// TALENT-INTEL-1 (TI-1F-A) — the résumé-extraction-draft worker. Proves the
// EXISTING-Talent path is WORKER-OWNED after enqueue: a PROCESSING ATTACHMENT
// draft is driven to READY_FOR_REVIEW | FAILED by ONE governed extraction, and
// the worker writes NO typed Talent evidence (the mock exposes only draft ops).

function make(parts: {
  drafts?: unknown[];
  extractResult?: unknown;
  extractThrows?: boolean;
  isConfigured?: boolean;
}) {
  const findProcessing = vi.fn().mockResolvedValue(parts.drafts ?? []);
  const markReady = vi.fn().mockResolvedValue(undefined);
  const markFailed = vi.fn().mockResolvedValue(undefined);
  // ONLY draft ops — no evidence-writing method exists on this mock, so any
  // attempt by the worker to author typed evidence would throw (it does not).
  const talentExtraction = {
    findProcessingResumeExtractionDrafts: findProcessing,
    markResumeExtractionDraftReadyForReview: markReady,
    markResumeExtractionDraftFailed: markFailed,
  } as never;
  const extractResume = parts.extractThrows
    ? vi.fn().mockRejectedValue(new Error('boom'))
    : vi.fn().mockResolvedValue(
        parts.extractResult ?? {
          prefill: { first_name: 'Grace' },
          parse_status: 'parsed',
          extraction_status: 'success',
          source_map_version: 'resume-source-map/v1',
          resume_text_hash: 'h',
        },
      );
  const orchestrator = { extractResume } as never;
  const register = vi.fn();
  const registrar = { register } as never;
  const redisConfig = { isConfigured: parts.isConfigured ?? false } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
  const processor = new ResumeExtractionDraftProcessor(
    orchestrator,
    talentExtraction,
    registrar,
    redisConfig,
    logger,
  );
  return { processor, findProcessing, markReady, markFailed, extractResume, register };
}

function attachmentDraft(over: Record<string, unknown> = {}) {
  return {
    id: 'dr-1',
    tenant_id: 't-1',
    source_kind: 'ATTACHMENT',
    source_ref: 'att-1',
    talent_id: 'tal-1',
    talent_document_id: 'doc-1',
    resume_edition_id: 'ed-1',
    status: 'PROCESSING',
    ...over,
  };
}

describe('ResumeExtractionDraftProcessor.drainProcessingBatch (TI-1F-A)', () => {
  it('ATTACHMENT draft → exactly ONE governed extract → READY_FOR_REVIEW; NO typed evidence', async () => {
    const { processor, extractResume, markReady, markFailed } = make({ drafts: [attachmentDraft()] });
    const out = await processor.drainProcessingBatch({ limit: 10 });
    expect(extractResume).toHaveBeenCalledTimes(1);
    expect(extractResume).toHaveBeenCalledWith(
      { kind: 'ATTACHMENT', attachment_id: 'att-1', talent_id: 'tal-1' },
      expect.objectContaining({ tenant_id: 't-1' }),
    );
    expect(markReady).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dr-1', source_map_version: 'resume-source-map/v1' }),
    );
    expect(markFailed).not.toHaveBeenCalled();
    expect(out).toEqual({ attempted: 1, ready_for_review: 1, failed: 0 });
  });

  it('a technical extraction-failure status → FAILED, never READY_FOR_REVIEW', async () => {
    const { processor, markReady, markFailed } = make({
      drafts: [attachmentDraft()],
      extractResult: { prefill: {}, parse_status: 'partial', extraction_status: 'provider_failure' },
    });
    await processor.drainProcessingBatch({ limit: 10 });
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dr-1', last_error_code: 'provider_failure' }),
    );
    expect(markReady).not.toHaveBeenCalled();
  });

  it('an unexpected throw → FAILED (per-draft isolation, batch continues)', async () => {
    const { processor, markFailed } = make({ drafts: [attachmentDraft({ id: 'dr-x' })], extractThrows: true });
    const out = await processor.drainProcessingBatch({ limit: 10 });
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dr-x', last_error_code: 'EXTRACTION_FAILED' }),
    );
    expect(out.failed).toBe(1);
  });

  it('a PROCESSING draft that is not an existing-Talent ATTACHMENT is marked FAILED, never extracted', async () => {
    const { processor, extractResume, markFailed } = make({
      drafts: [attachmentDraft({ source_kind: 'CREATE_DRAFT_UPLOAD', talent_id: null, resume_edition_id: null })],
    });
    await processor.drainProcessingBatch({ limit: 10 });
    expect(extractResume).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ last_error_code: 'INVALID_DRAFT_SOURCE' }),
    );
  });
});

describe('ResumeExtractionDraftProcessor.onApplicationBootstrap', () => {
  it('registers the worker when Redis is configured', () => {
    const { processor, register } = make({ isConfigured: true });
    processor.onApplicationBootstrap();
    expect(register).toHaveBeenCalledOnce();
  });

  it('stays silent (no registration) when Redis is unconfigured', () => {
    const { processor, register } = make({ isConfigured: false });
    processor.onApplicationBootstrap();
    expect(register).not.toHaveBeenCalled();
  });
});
