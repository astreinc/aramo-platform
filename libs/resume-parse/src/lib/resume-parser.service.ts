import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import { ObjectStorageService } from '@aramo/object-storage';

import { extractResumeText } from './heuristics/text-extractor.js';
import type { ParseResumeInput } from './types/parse-resume.types.js';

// ResumeParserService — deterministic file → TEXT extraction (NO LLM, ADR-0015
// Decision 10).
//
// Fetches the object bytes and magic-byte-extracts plain text (pdf-parse /
// mammoth). It does NOT extract résumé FACTS: governed LLM is the SOLE
// production résumé fact extractor (…-TI-1F-…-v1_0-LOCKED §4-D). TI-1F P0.2
// retired the heuristic field-extraction path (parseFromStorageKey / parseBytes
// / field-extractor); the extracted TEXT is handed to @aramo/talent-extraction
// (a permitted LLM consumer) which redacts PII before the model.
//
// Failure semantics: never throws on a parse failure — extractTextFromStorageKey
// returns null (non-blocking). The only throw paths are presigned-GET / fetch
// network failures (OBJECT_STORAGE_UPLOAD_FAILED). PII floor (§17): callers MUST
// NOT log the returned text — in-process use only.

@Injectable()
export class ResumeParserService {
  constructor(
    private readonly objectStorage: ObjectStorageService,
    @Inject('ResumeParserServiceLogger') private readonly logger: AramoLogger,
  ) {}

  // Fetch the object bytes and return ONLY the extracted plain text (single
  // fetch + single extraction). Returns null on a parse failure (non-blocking).
  async extractTextFromStorageKey(input: ParseResumeInput): Promise<string | null> {
    const buffer = await this.fetchBytes(input);
    const text = await extractResumeText(buffer);
    this.logger.log({
      event: text === null ? 'resume_text.failed' : 'resume_text.extracted',
      requestId: input.requestId,
      storage_key: input.storage_key,
      // PII-floor: length only — never the extracted text.
      text_length: text?.length ?? 0,
    });
    return text;
  }

  // The presigned-GET + fetch. Throws OBJECT_STORAGE_UPLOAD_FAILED (502) on a
  // missing key / presign / network failure — the caller maps that as needed.
  async fetchBytes(input: ParseResumeInput): Promise<Buffer> {
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

    try {
      const response = await fetch(presigned_url);
      if (!response.ok) {
        throw new Error(`fetch returned status ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
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
  }
}
