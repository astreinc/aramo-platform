// CI-B6 — citation validation (directive §span-validation). B6 NEVER trusts
// model-provided citations: every citation is re-checked against the exact
// normalized transcript this run was grounded on. A citation to a nonexistent
// utterance (incl. a cross-transcript id) → CITATION_INVALID; an out-of-range
// span or a quote that does not match the utterance text → CITATION_SPAN_MISMATCH.

import { CI_PROCESSING_ERROR_CODES, CiAnalysisValidationError } from '../domain/errors.js';
import type { NormalizedTranscriptView } from '../ports/normalized-transcript-source.port.js';

import type { AnalysisResultV1 } from './analysis-schema.js';

/** Whitespace-collapsed, case-insensitive compare (evidence fidelity, tolerant of formatting). */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Validate all citations in `result` against `transcript`. Throws
 * {@link CiAnalysisValidationError} on the first invalid citation.
 */
export function validateCitationsAgainstTranscript(
  result: AnalysisResultV1,
  transcript: NormalizedTranscriptView,
): void {
  const byId = new Map<string, string>();
  for (const u of transcript.utterances) byId.set(u.utterance_id, u.text);

  result.claims.forEach((claim, i) => {
    claim.citations.forEach((cit, j) => {
      const text = byId.get(cit.utterance_id);
      if (text === undefined) {
        // Utterance not in THIS transcript (nonexistent or cross-transcript).
        throw new CiAnalysisValidationError(
          CI_PROCESSING_ERROR_CODES.CITATION_INVALID,
          `claims[${i}].citations[${j}] cites unknown utterance`,
        );
      }
      const wantQuote = norm(cit.quote);
      if (cit.start_offset !== undefined && cit.end_offset !== undefined) {
        if (cit.start_offset > cit.end_offset || cit.end_offset > text.length) {
          throw new CiAnalysisValidationError(
            CI_PROCESSING_ERROR_CODES.CITATION_SPAN_MISMATCH,
            `claims[${i}].citations[${j}] span out of range`,
          );
        }
        const excerpt = norm(text.slice(cit.start_offset, cit.end_offset));
        if (excerpt !== wantQuote && !excerpt.includes(wantQuote)) {
          throw new CiAnalysisValidationError(
            CI_PROCESSING_ERROR_CODES.CITATION_SPAN_MISMATCH,
            `claims[${i}].citations[${j}] span text mismatch`,
          );
        }
      } else if (!norm(text).includes(wantQuote)) {
        throw new CiAnalysisValidationError(
          CI_PROCESSING_ERROR_CODES.CITATION_SPAN_MISMATCH,
          `claims[${i}].citations[${j}] quote not found in utterance`,
        );
      }
    });
  });
}
