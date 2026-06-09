import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import { ObjectStorageService } from '@aramo/object-storage';
import { extractResumeText } from '@aramo/resume-parse';

import { PrismaService } from '../prisma/prisma.service.js';

import { redactResumeText } from './redaction.js';

// Search PR-2 — ResumeTextService: the async résumé-text re-extract +
// persistence path (the NEW post-create seam; the E2 parse path is untouched).
//
// THE TRIGGER (Lead Ruling R1 — async, post-attachment-commit). The résumé
// Attachment binds in a SEPARATE request AFTER the TalentRecord is created
// (E3), so the natural anchor is the résumé-attachment commit, not talent-
// create. At that seam the AttachmentController calls enqueueReindex() — a
// single fast upsert that writes a `pending` row (NO S3 fetch in the request
// path). The heavy work (S3 fetch + extract + redact) runs asynchronously in
// drainPendingBatch(), driven by the Redis-gated ResumeReindexProcessor tick.
//
// THE POLLING-OUTBOX SHAPE (the canonicalization-trigger precedent): the
// `pending` row IS the work-to-do signal. Durability — a failed extract is
// marked 'failed' and re-enqueue (a re-attach) replays it; nothing is lost.
// No cross-lib enqueue plumbing: talent-record never reads the attachment
// schema (that edge would cycle — attachment already imports talent-record).
//
// Reuse: extractResumeText (the deterministic pdf-parse / mammoth extractor,
// no-LLM per ADR-0015 D10) + the createPresignedGet → fetch pattern (mirrors
// ResumeParserService without modifying it). redactResumeText (D4) runs
// BEFORE persist, so only redacted text is ever stored / indexed / shown.

const RESUME_REINDEX_BATCH_DEFAULT = 50;

export interface EnqueueReindexInput {
  tenant_id: string;
  talent_record_id: string;
  attachment_id: string;
  storage_key: string;
}

export interface DrainResult {
  attempted: number;
  extracted: number;
  failed: number;
}

@Injectable()
export class ResumeTextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly objectStorage: ObjectStorageService,
    @Inject('ResumeTextServiceLogger') private readonly logger: AramoLogger,
  ) {}

  // Enqueue (or re-enqueue) a talent record for résumé-text re-extraction.
  // Upserts the 1:1-latest row to `pending` with the source pointer. Fast +
  // synchronous (a single upsert) — safe to call in the attachment-commit
  // request path. Re-attaching a newer résumé flips the row back to pending
  // (the next drain re-extracts; the prior text keeps matching until replaced).
  async enqueueReindex(input: EnqueueReindexInput): Promise<void> {
    await this.prisma.talentResumeText.upsert({
      where: { talent_record_id: input.talent_record_id },
      create: {
        tenant_id: input.tenant_id,
        talent_record_id: input.talent_record_id,
        attachment_id: input.attachment_id,
        storage_key: input.storage_key,
        status: 'pending',
      },
      update: {
        attachment_id: input.attachment_id,
        storage_key: input.storage_key,
        status: 'pending',
      },
    });
    this.logger.log({
      event: 'resume_text.reindex_enqueued',
      tenant_id: input.tenant_id,
      talent_record_id: input.talent_record_id,
      attachment_id: input.attachment_id,
    });
  }

  // Drain a batch of pending rows: fetch the retained S3 object, extract the
  // text, REDACT (D4), persist + flip to 'extracted'. Per-row isolation — a
  // single failure marks that row 'failed' and does NOT abort the batch.
  // Exercised directly by the proof specs (the canonicalization drainBatch
  // precedent — no live worker needed for the proofs).
  async drainPendingBatch(args?: { limit?: number }): Promise<DrainResult> {
    const limit = args?.limit ?? RESUME_REINDEX_BATCH_DEFAULT;
    const pending = await this.prisma.talentResumeText.findMany({
      where: { status: 'pending' },
      orderBy: { created_at: 'asc' },
      take: limit,
    });

    if (pending.length === 0) {
      return { attempted: 0, extracted: 0, failed: 0 };
    }

    let extracted = 0;
    let failed = 0;

    for (const row of pending) {
      try {
        await this.reextractOne({
          id: row.id,
          tenant_id: row.tenant_id,
          talent_record_id: row.talent_record_id,
          storage_key: row.storage_key,
        });
        extracted += 1;
      } catch (err) {
        failed += 1;
        await this.markFailed(row.id);
        this.logger.warn({
          event: 'resume_text.reextract_failed',
          talent_record_id: row.talent_record_id,
          error_message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log({
      event: 'resume_text.reindex_tick_completed',
      attempted: pending.length,
      extracted,
      failed,
    });
    return { attempted: pending.length, extracted, failed };
  }

  // Re-extract + redact + persist a single row. Throws on a missing source
  // pointer or an unextractable file (caller marks the row 'failed').
  private async reextractOne(row: {
    id: string;
    tenant_id: string;
    talent_record_id: string;
    storage_key: string | null;
  }): Promise<void> {
    if (row.storage_key === null || row.storage_key.length === 0) {
      throw new Error('missing storage_key for re-extract');
    }

    const { presigned_url } = await this.objectStorage.createPresignedGet({
      storage_key: row.storage_key,
      requestId: `resume-reextract:${row.talent_record_id}`,
    });

    const response = await fetch(presigned_url);
    if (!response.ok) {
      throw new Error(`résumé fetch returned status ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const rawText = await extractResumeText(buffer);
    if (rawText === null) {
      throw new Error('text extraction failed (unsupported/corrupt file)');
    }

    // D4 — redact SSN-shaped patterns BEFORE persist. Only redacted text is
    // stored; the generated tsvector + ts_headline snippet derive from it.
    const redacted = redactResumeText(rawText);

    await this.prisma.talentResumeText.update({
      where: { id: row.id },
      data: {
        redacted_text: redacted,
        status: 'extracted',
        extracted_at: new Date(),
      },
    });

    this.logger.log({
      event: 'resume_text.reextracted',
      tenant_id: row.tenant_id,
      talent_record_id: row.talent_record_id,
      // PII-floor: lengths, never values.
      text_length: redacted.length,
    });
  }

  private async markFailed(id: string): Promise<void> {
    await this.prisma.talentResumeText.update({
      where: { id },
      data: { status: 'failed' },
    });
  }
}
