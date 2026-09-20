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
  // The producing résumé Attachment. OPTIONAL since TI-1H: the confirmed-create
  // path mints an edition from a raw draft upload with NO owned Attachment
  // (attachment_id stays null on that edition's text row).
  attachment_id?: string;
  storage_key: string;
  // TALENT-INTEL-1 TI-1D-C §D / TI-1H — the TalentResumeEdition this text belongs
  // to. When PRESENT (the edition-ingestion paths: confirmed-create + POST
  // resume-editions) the write targets that edition's OWN durable row (history).
  // When OMITTED (the plain attachment-commit caller) the write maintains a
  // single edition-blind transient row for the attachment (TalentEditDrawer
  // path), which a later edition-aware write ADOPTS.
  resume_edition_id?: string;
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

  // Enqueue (or re-enqueue) a résumé for text re-extraction. TI-1H: EDITION-
  // AWARE. A single fast set of writes (no S3 fetch here) — safe in the
  // attachment-commit request path. Two modes:
  //
  //   • edition-aware (resume_edition_id present): writes/keeps THAT edition's
  //     OWN durable row — a newer edition never overwrites an older edition's
  //     text (§5). First ADOPTS a prior edition-blind transient for the same
  //     attachment so the TalentEditView commit→edition sequence converges to
  //     ONE row (rather than stranding a NULL transient beside the edition row).
  //     Same-edition retry re-pends the same row (idempotent — no duplicate
  //     history, §7).
  //   • edition-blind (resume_edition_id omitted, attachment-commit): maintains a
  //     single transient row per résumé attachment (deduped by attachment_id);
  //     if an edition already owns that attachment, re-pends the edition row.
  async enqueueReindex(input: EnqueueReindexInput): Promise<void> {
    if (input.resume_edition_id !== undefined) {
      await this.writeEditionRow(input, input.resume_edition_id);
    } else {
      await this.writeTransientRow(input);
    }
    this.logger.log({
      event: 'resume_text.reindex_enqueued',
      tenant_id: input.tenant_id,
      talent_record_id: input.talent_record_id,
      attachment_id: input.attachment_id,
    });
  }

  // Edition-aware write: this edition's own durable row. Adopts a same-attachment
  // transient when one exists (and no edition row already claims the edition),
  // otherwise upserts on the (tenant, talent, edition) key.
  private async writeEditionRow(
    input: EnqueueReindexInput,
    resume_edition_id: string,
  ): Promise<void> {
    const editionRow = await this.prisma.talentResumeText.findUnique({
      where: {
        tenant_id_talent_record_id_resume_edition_id: {
          tenant_id: input.tenant_id,
          talent_record_id: input.talent_record_id,
          resume_edition_id,
        },
      },
      select: { id: true },
    });

    // Adopt a prior edition-blind transient for this attachment (the row the
    // attachment-commit seam wrote) so both writes converge to one row.
    if (input.attachment_id !== undefined) {
      const transient = await this.prisma.talentResumeText.findFirst({
        where: {
          tenant_id: input.tenant_id,
          talent_record_id: input.talent_record_id,
          attachment_id: input.attachment_id,
          resume_edition_id: null,
        },
        select: { id: true },
      });
      if (transient !== null) {
        if (editionRow !== null) {
          // The edition already has its own row — the transient is redundant.
          await this.prisma.talentResumeText.delete({ where: { id: transient.id } });
        } else {
          await this.prisma.talentResumeText.update({
            where: { id: transient.id },
            data: { resume_edition_id, storage_key: input.storage_key, status: 'pending' },
          });
          return;
        }
      }
    }

    await this.prisma.talentResumeText.upsert({
      where: {
        tenant_id_talent_record_id_resume_edition_id: {
          tenant_id: input.tenant_id,
          talent_record_id: input.talent_record_id,
          resume_edition_id,
        },
      },
      create: {
        tenant_id: input.tenant_id,
        talent_record_id: input.talent_record_id,
        attachment_id: input.attachment_id,
        storage_key: input.storage_key,
        status: 'pending',
        resume_edition_id,
      },
      // Same-edition retry: re-pend the SAME row (never a new history row).
      update: {
        attachment_id: input.attachment_id,
        storage_key: input.storage_key,
        status: 'pending',
      },
    });
  }

  // Edition-blind write (attachment-commit): a committed résumé attachment not
  // (yet) an edition. If an edition already owns this attachment, re-pend that
  // row; else keep a single transient per attachment.
  private async writeTransientRow(input: EnqueueReindexInput): Promise<void> {
    const owning = await this.prisma.talentResumeText.findFirst({
      where: {
        tenant_id: input.tenant_id,
        talent_record_id: input.talent_record_id,
        attachment_id: input.attachment_id,
      },
      // Prefer an edition row (non-null) over the transient if both exist.
      orderBy: [{ resume_edition_id: { sort: 'desc', nulls: 'last' } }],
      select: { id: true },
    });
    if (owning !== null) {
      await this.prisma.talentResumeText.update({
        where: { id: owning.id },
        data: { storage_key: input.storage_key, status: 'pending' },
      });
      return;
    }
    await this.prisma.talentResumeText.create({
      data: {
        tenant_id: input.tenant_id,
        talent_record_id: input.talent_record_id,
        attachment_id: input.attachment_id,
        storage_key: input.storage_key,
        status: 'pending',
      },
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
