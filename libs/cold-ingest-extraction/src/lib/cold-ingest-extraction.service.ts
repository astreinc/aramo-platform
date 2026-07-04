import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import type { ArrivalNeedingExtraction } from '@aramo/ingestion';
import { IngestionRepository } from '@aramo/ingestion';
import { ResumeParserService } from '@aramo/resume-parse';
import type { TalentRecordPrefill } from '@aramo/resume-parse';
import { TalentTrustService } from '@aramo/talent-trust';
import type { DeclaredEvidenceEntry } from '@aramo/talent-trust';

import { COLD_INGEST_EXTRACTION_ACTOR } from './cold-ingest-extraction.queue.constants.js';

// Cold-Ingest Extraction — per-arrival extraction.
//
// The gap this closes: a cold-ingest arrival is canonicalized to an L2
// ResolutionSubject carrying only EMAIL + PROFILE_URL evidence (the channel
// signals). Promotion to a TalentRecord needs a NAME (TalentRecord.create's
// first_name/last_name are non-nullable). The name lives in the résumé bytes
// already retained at storage_ref. This poll re-reads that résumé with the
// EXISTING deterministic parser (resume-parse.parseFromStorageKey — no LLM,
// ADR-0015 Decision 10) and writes the parsed identity fields as declared
// evidence onto the arrival's resolved_subject_id.
//
// Trust posture (unchanged from Amendment v1.1 core): everything written here
// is THIRD_PARTY_UNVERIFIED / DOCUMENT — a channel-sourced declared claim,
// never SELF, never verified. Structuring a résumé is not verification.
//
// Outcome → marker mapping (the extract-once gate):
//   - extracted        → identity fields written; markExtractionDone (permanent).
//   - done_no_identity → parsed but no name/contact identity fields to write;
//                        markExtractionDone (permanent — a name-less résumé must
//                        NOT loop).
//   - transient_retry  → parse threw (S3 presign / network); bumpExtractionAttempt
//                        and leave the gate NULL so a later tick re-picks (bounded
//                        by findArrivalsNeedingExtraction's attempts < cap filter).

export type ExtractOutcome = 'extracted' | 'done_no_identity' | 'transient_retry';

export interface ExtractResult {
  payload_id: string;
  outcome: ExtractOutcome;
  entry_count: number;
}

// Pure prefill → declared-evidence mapping. Exported for unit tests (the
// PII-shape is asserted without standing up the poll). All entries are the
// IDENTITY dimension — name is the promotion-critical field; phone + address
// are the other identity facts the same deterministic parse yields. EMAIL /
// PROFILE_URL are NOT re-written here — the canonicalize arrival already
// attached them (talent-trust.attachContactEvidence). key_skills stays with
// ingestion's skill_surface_forms (no duplication).
export function buildDeclaredIdentityEntries(
  prefill: TalentRecordPrefill,
  payload_id: string,
): DeclaredEvidenceEntry[] {
  const entries: DeclaredEvidenceEntry[] = [];

  const first_name = nonEmpty(prefill.first_name);
  const last_name = nonEmpty(prefill.last_name);
  if (first_name !== undefined || last_name !== undefined) {
    entries.push({
      dimension: 'IDENTITY',
      assertion_type: 'FULL_NAME',
      assertion_payload: pruneUndefined({ first_name, last_name, payload_id }),
    });
  }

  // First present phone in cell → home → work precedence.
  const phone =
    nonEmpty(prefill.phone_cell) ??
    nonEmpty(prefill.phone_home) ??
    nonEmpty(prefill.phone_work);
  if (phone !== undefined) {
    entries.push({
      dimension: 'IDENTITY',
      assertion_type: 'PHONE',
      assertion_payload: { value: phone, payload_id },
    });
  }

  const address = nonEmpty(prefill.address);
  const address2 = nonEmpty(prefill.address2);
  const city = nonEmpty(prefill.city);
  const state = nonEmpty(prefill.state);
  const zip = nonEmpty(prefill.zip);
  if (
    address !== undefined ||
    address2 !== undefined ||
    city !== undefined ||
    state !== undefined ||
    zip !== undefined
  ) {
    entries.push({
      dimension: 'IDENTITY',
      assertion_type: 'ADDRESS',
      assertion_payload: pruneUndefined({
        address,
        address2,
        city,
        state,
        zip,
        payload_id,
      }),
    });
  }

  return entries;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function pruneUndefined(
  obj: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

@Injectable()
export class ColdIngestExtractionService {
  constructor(
    private readonly ingestionRepo: IngestionRepository,
    private readonly resumeParser: ResumeParserService,
    private readonly talentTrust: TalentTrustService,
    @Inject('ColdIngestExtractionServiceLogger')
    private readonly logger: AramoLogger,
  ) {}

  // Extract one resolved arrival. Never throws — a transient parse failure is
  // caught + logged + bumped (the poll's per-arrival isolation, mirroring the
  // canonicalize trigger). The caller (the processor) counts outcomes.
  async extractArrival(arrival: ArrivalNeedingExtraction): Promise<ExtractResult> {
    const requestId = `cold-ingest-extract:${arrival.id}`;

    let parseResult;
    try {
      parseResult = await this.resumeParser.parseFromStorageKey({
        storage_key: arrival.storage_ref,
        requestId,
      });
    } catch (err) {
      // Transient — S3 presign / network fetch failure. Leave the gate NULL,
      // bump the attempt counter; a later tick re-picks (bounded by the cap).
      await this.ingestionRepo.bumpExtractionAttempt(arrival.id);
      this.logger.warn({
        event: 'cold_ingest_extraction_transient_failure',
        payload_id: arrival.id,
        tenant_id: arrival.tenant_id,
        error_code: err instanceof AramoError ? err.code : 'UNKNOWN',
        error_message: err instanceof Error ? err.message : String(err),
      });
      return { payload_id: arrival.id, outcome: 'transient_retry', entry_count: 0 };
    }

    const entries = buildDeclaredIdentityEntries(parseResult.prefill, arrival.id);

    if (entries.length === 0) {
      // Parsed, but no identity fields to write (e.g. text extraction failed,
      // or the parse yielded no name/phone/address). Permanent — stamp done so
      // the row leaves the poll and never loops.
      await this.ingestionRepo.markExtractionDone(arrival.id);
      this.logger.log({
        event: 'cold_ingest_extraction_no_identity',
        payload_id: arrival.id,
        tenant_id: arrival.tenant_id,
        parse_status: parseResult.parse_status,
      });
      return { payload_id: arrival.id, outcome: 'done_no_identity', entry_count: 0 };
    }

    await this.talentTrust.recordDeclaredEvidenceForSubject({
      tenant_id: arrival.tenant_id,
      subject_id: arrival.resolved_subject_id,
      entries,
      created_by: COLD_INGEST_EXTRACTION_ACTOR,
    });

    // Stamp AFTER the evidence write — the marker is the last write, so a crash
    // between them leaves the gate NULL and the next tick re-picks (at worst a
    // rare duplicate declared record; recompute is convergent). This mirrors
    // the canonicalize resolved_subject_id "last-write gate" ordering.
    await this.ingestionRepo.markExtractionDone(arrival.id);

    this.logger.log({
      event: 'cold_ingest_extraction_completed',
      payload_id: arrival.id,
      tenant_id: arrival.tenant_id,
      subject_id: arrival.resolved_subject_id,
      parse_status: parseResult.parse_status,
      entry_count: entries.length,
    });
    return { payload_id: arrival.id, outcome: 'extracted', entry_count: entries.length };
  }
}
