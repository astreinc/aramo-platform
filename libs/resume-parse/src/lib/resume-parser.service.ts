import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import { ObjectStorageService } from '@aramo/object-storage';

import {
  extractFields,
  meetsMinimalIdentity,
} from './heuristics/field-extractor.js';
import { extractResumeText } from './heuristics/text-extractor.js';
import type {
  ParseResumeInput,
  ParseResumeResult,
} from './types/parse-resume.types.js';

// A8-3b — ResumeParserService: deterministic parse-to-prefill.
//
// Flow:
//   1. Request a presigned GET URL from ObjectStorageService.
//   2. fetch() the bytes (the browser-direct pattern; the API never
//      hosts bytes -- mirrors the upload direction).
//   3. Magic-byte detect (PDF | DOCX | unknown).
//   4. Extract text via pdf-parse or mammoth.
//   5. Heuristic field-extraction (NO LLM per ADR-0015 Decision 10).
//   6. Return { prefill, parse_status }.
//
// Failure semantics: this service NEVER throws on parse failure. A
// failed parse returns { prefill: {}, parse_status: 'failed' } -- the
// recruiter creates the TalentRecord manually. The only throw paths are
// (a) presigned-GET generation failure (OBJECT_STORAGE_UPLOAD_FAILED,
// upstream), (b) fetch network failure (OBJECT_STORAGE_UPLOAD_FAILED).
// Parse-failure-is-non-blocking is the proof §4.4 invariant.

@Injectable()
export class ResumeParserService {
  constructor(
    private readonly objectStorage: ObjectStorageService,
    @Inject('ResumeParserServiceLogger') private readonly logger: AramoLogger,
  ) {}

  async parseFromStorageKey(
    input: ParseResumeInput,
  ): Promise<ParseResumeResult> {
    if (input.storage_key.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'storage_key must be non-empty',
        400,
        { requestId: input.requestId, details: { field: 'storage_key' } },
      );
    }

    const { presigned_url } = await this.objectStorage.createPresignedGet({
      storage_key: input.storage_key,
      requestId: input.requestId,
    });

    let buffer: Buffer;
    try {
      const response = await fetch(presigned_url);
      if (!response.ok) {
        throw new Error(`fetch returned status ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AramoError(
        'OBJECT_STORAGE_UPLOAD_FAILED',
        `résumé fetch failed: ${message}`,
        502,
        {
          requestId: input.requestId,
          details: {
            kind: 'resume_fetch_failed',
            storage_key: input.storage_key,
          },
        },
      );
    }

    const text = await extractResumeText(buffer);
    if (text === null) {
      // Parse-failure is NON-BLOCKING (proof §4.4): return failed with
      // an empty prefill; the recruiter creates the TalentRecord manually.
      this.logger.log({
        event: 'resume_parse.failed',
        requestId: input.requestId,
        storage_key: input.storage_key,
        reason: 'text_extraction_failed',
      });
      return { prefill: {}, parse_status: 'failed' };
    }

    const prefill = extractFields(text);
    const parse_status = meetsMinimalIdentity(prefill) ? 'parsed' : 'partial';

    this.logger.log({
      event: 'resume_parse.completed',
      requestId: input.requestId,
      storage_key: input.storage_key,
      parse_status,
      // PII-floor: count the populated fields rather than the values.
      populated_field_count: Object.values(prefill).filter(
        (v) => typeof v === 'string' && v.length > 0,
      ).length,
      text_length: text.length,
    });

    return { prefill, parse_status };
  }
}
