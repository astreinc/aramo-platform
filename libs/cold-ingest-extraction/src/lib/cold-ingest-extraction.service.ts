import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import type { ArrivalNeedingExtraction } from '@aramo/ingestion';
import { IngestionRepository } from '@aramo/ingestion';
import { ResumeParserService } from '@aramo/resume-parse';
import type { TalentRecordPrefill, ParseResumeResult } from '@aramo/resume-parse';
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

// SRC-2 PR-1 — the Indeed apply résumé field path. Per Indeed's application-data
// docs, an UPLOADED résumé's base64 bytes live at `applicant.resume.file.data`
// (with sibling fileName/contentType). The résumé is OPTIONAL. The structured
// "Indeed Resume" variants (applicant.resume.{json,text,html}) carry no file
// BYTES for the deterministic parser and are NOT decoded here. Returns the base64
// string, or null when absent — a null is a résumé-less envelope (permanent
// done_no_identity, the 'unknown'→done_no_identity analogue). Exported for the
// unit test (the field-path shape is asserted without standing up the poll).
export function extractIndeedResumeBase64(envelope: unknown): string | null {
  const obj = (v: unknown): Record<string, unknown> | null =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  const root = obj(envelope);
  const applicant = root === null ? null : obj(root['applicant']);
  const resume = applicant === null ? null : obj(applicant['resume']);
  const file = resume === null ? null : obj(resume['file']);
  const data = file === null ? undefined : file['data'];
  return typeof data === 'string' && data.length > 0 ? data : null;
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
      // SRC-2 PR-1 (R8) — content-type discriminator. 'application/json' (the SRC-1
      // apply webhook) stores a JSON envelope with the résumé base64 INSIDE it;
      // every other content_type is a bare résumé object (existing path, unchanged).
      parseResult =
        arrival.content_type === 'application/json'
          ? await this.parseJsonEnvelope(arrival.storage_ref, requestId)
          : await this.resumeParser.parseFromStorageKey({
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

  // SRC-2 PR-1 (R8) — the content-type-aware JSON-envelope path. A webhook arrival
  // (content_type application/json) stores a JSON envelope, not a bare résumé; the
  // résumé bytes are base64 at applicant.resume.file.data. REUSE the SAME storage
  // fetch (ResumeParserService.fetchBytes — no duplicate presign), parse the
  // envelope, decode the résumé, and hand the DECODED bytes to the EXISTING
  // magic-byte extractor (parseBytes). Failure taxonomy mirrors the non-JSON path:
  //   - fetch throw OR malformed-JSON throw → propagate → extractArrival maps to
  //     transient_retry (bounded by attempts < cap);
  //   - a parsed envelope with NO résumé field → empty prefill → the caller's
  //     entries.length === 0 branch → permanent done_no_identity (the
  //     'unknown'→done_no_identity analogue).
  private async parseJsonEnvelope(
    storageRef: string,
    requestId: string,
  ): Promise<ParseResumeResult> {
    const bytes = await this.resumeParser.fetchBytes({
      storage_key: storageRef,
      requestId,
    });
    // Malformed JSON throws → caught by extractArrival → transient_retry (the
    // attempts<cap budget bounds a persistently-malformed envelope).
    const envelope: unknown = JSON.parse(bytes.toString('utf8'));
    const resumeBase64 = extractIndeedResumeBase64(envelope);
    if (resumeBase64 === null) {
      // Envelope parsed, no résumé to read — permanent (never gains one on retry).
      return { prefill: {}, parse_status: 'failed' };
    }
    return this.resumeParser.parseBytes(Buffer.from(resumeBase64, 'base64'), {
      storage_key: storageRef,
      requestId,
    });
  }
}
