// TIP-E2E INC-3 A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part D.1/D.2) — the
// SCREENING analysis profile contract. Same posture as the CI-B6 analysis.v1
// contract (fixed versioned prompt, strict JSON schema, allowlist validator,
// citation re-validation against the exact normalized transcript, protected-
// trait refusal) — a second PROFILE of the one CI engine, not a second engine.
// Output is DRAFT findings for recruiter review in the screening domain; nothing
// here is a verified fact, and nothing orders, compares or decides about people.

import { createHash } from 'node:crypto';

import { CI_PROCESSING_ERROR_CODES, CiAnalysisValidationError } from '../domain/errors.js';
import type { ScreeningAnalysisContext } from '../ports/screening-analysis.port.js';

import { PROTECTED_TRAIT_MARKERS } from './analysis-schema.js';

export const CI_ANALYSIS_PROFILE_REQUISITION = 'REQUISITION';
export const CI_ANALYSIS_PROFILE_SCREENING = 'SCREENING';
export type CiAnalysisProfile = typeof CI_ANALYSIS_PROFILE_REQUISITION | typeof CI_ANALYSIS_PROFILE_SCREENING;

export const CI_SCREENING_SCHEMA_VERSION = 'conversation-intelligence.screening-analysis.v1';
export const CI_SCREENING_PROMPT_TEMPLATE_ID = 'conversation-intelligence.screening-analysis';
export const CI_SCREENING_PROMPT_TEMPLATE_VERSION = 'v1';
export const CI_SCREENING_JSON_SCHEMA_NAME = 'screening_analysis_v1';
export const CI_SCREENING_CLAIM_TYPE = 'screening_finding_draft';

export const CI_SCREENING_MAX_FINDINGS = 12;
export const CI_SCREENING_SKILL_MAX = 200;
export const CI_SCREENING_TEXT_MAX = 2000;
export const CI_SCREENING_MAX_CITATIONS = 5;

export const CI_SCREENING_PROMPT_TEMPLATE_TEXT = [
  'You draft technical screening findings for a recruiter to review, from one interview transcript.',
  'Use ONLY the provided normalized transcript and the provided screening context (question plan, recruiter notes, minimized profile, optional Requisition context). Do not use outside knowledge.',
  'A finding records what the talent SAID about one technical skill in this conversation. It is a statement about the conversation, never a verified fact, never a judgement of ability.',
  'Write the observation as what was stated or shown in conversation (for example: "Described running three production clusters and how upgrades were rolled out"). Put gaps, hedges or unclear points in limitations, or null.',
  'Do NOT produce any numeric ordering, fit metric, suitability measure, hiring recommendation, pass or fail outcome, or comparison between people. Do NOT decide anything about the talent.',
  'Do NOT infer or extract protected or sensitive attributes (e.g. race, religion, disability, medical, pregnancy, political, genetic, national origin, age).',
  'Every finding MUST cite transcript evidence: the exact utterance_id and a short verbatim quote copied from that utterance. A finding without a valid citation is invalid.',
  'Only cite utterances spoken by the talent or that directly frame the talent answer. If a skill was not discussed, do not create a finding for it.',
  `Return ONLY a JSON object matching schema ${CI_SCREENING_SCHEMA_VERSION}, with at most ${CI_SCREENING_MAX_FINDINGS} findings. Emit no prose outside the schema and no extra keys.`,
].join('\n');

export const CI_SCREENING_PROMPT_SHA256 = createHash('sha256')
  .update(CI_SCREENING_PROMPT_TEMPLATE_TEXT, 'utf8')
  .digest('hex');

export const CI_SCREENING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'findings'],
  properties: {
    schema_version: { type: 'string', enum: [CI_SCREENING_SCHEMA_VERSION] },
    findings: {
      type: 'array',
      maxItems: CI_SCREENING_MAX_FINDINGS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['skill', 'observation', 'limitations', 'citations'],
        properties: {
          skill: { type: 'string' },
          observation: { type: 'string' },
          limitations: { type: ['string', 'null'] },
          citations: {
            type: 'array',
            minItems: 1,
            maxItems: CI_SCREENING_MAX_CITATIONS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['utterance_id', 'quote'],
              properties: { utterance_id: { type: 'string' }, quote: { type: 'string' } },
            },
          },
        },
      },
    },
  },
} as const;

export interface ScreeningCitationV1 {
  readonly utterance_id: string;
  readonly quote: string;
}

export interface ScreeningFindingV1 {
  readonly skill: string;
  readonly observation: string;
  readonly limitations: string | null;
  readonly citations: readonly ScreeningCitationV1[];
}

export interface ScreeningAnalysisResultV1 {
  readonly schema_version: string;
  readonly findings: readonly ScreeningFindingV1[];
}

const TOP_KEYS = ['schema_version', 'findings'];
const FINDING_KEYS = ['skill', 'observation', 'limitations', 'citations'];
const CITATION_KEYS = ['utterance_id', 'quote'];

function mismatch(detail: string): never {
  throw new CiAnalysisValidationError(CI_PROCESSING_ERROR_CODES.MODEL_OUTPUT_SCHEMA_MISMATCH, detail);
}
function invalid(detail: string): never {
  throw new CiAnalysisValidationError(CI_PROCESSING_ERROR_CODES.MODEL_OUTPUT_INVALID, detail);
}
function keys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) mismatch(`${where} has forbidden key`);
}
function text(v: unknown, max: number, where: string): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) invalid(`${where} invalid`);
  return v.trim();
}
function protectedTrait(s: string): boolean {
  const lower = s.toLowerCase();
  return PROTECTED_TRAIT_MARKERS.some((m) => lower.includes(m));
}

/** Strict allowlist validation of a raw screening-profile model result. Detail strings are structural only. */
export function validateScreeningAnalysisResult(raw: unknown): ScreeningAnalysisResultV1 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('result is not an object');
  const root = raw as Record<string, unknown>;
  keys(root, TOP_KEYS, 'result');
  if (root['schema_version'] !== CI_SCREENING_SCHEMA_VERSION) mismatch('schema_version mismatch');
  const list = root['findings'];
  if (!Array.isArray(list) || list.length > CI_SCREENING_MAX_FINDINGS) mismatch('findings invalid');
  const findings: ScreeningFindingV1[] = list.map((f, i) => {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) mismatch(`findings[${i}] not an object`);
    const o = f as Record<string, unknown>;
    keys(o, FINDING_KEYS, `findings[${i}]`);
    const skill = text(o['skill'], CI_SCREENING_SKILL_MAX, `findings[${i}].skill`);
    const observation = text(o['observation'], CI_SCREENING_TEXT_MAX, `findings[${i}].observation`);
    const lim = o['limitations'];
    const limitations = lim === null || lim === undefined ? null : text(lim, CI_SCREENING_TEXT_MAX, `findings[${i}].limitations`);
    if ([skill, observation, limitations ?? ''].some(protectedTrait)) invalid(`findings[${i}] protected attribute`);
    const cits = o['citations'];
    if (!Array.isArray(cits) || cits.length === 0 || cits.length > CI_SCREENING_MAX_CITATIONS) {
      invalid(`findings[${i}].citations invalid`);
    }
    const citations = cits.map((c, j) => {
      if (c === null || typeof c !== 'object' || Array.isArray(c)) mismatch(`findings[${i}].citations[${j}] not an object`);
      const co = c as Record<string, unknown>;
      keys(co, CITATION_KEYS, `findings[${i}].citations[${j}]`);
      return {
        utterance_id: text(co['utterance_id'], 200, `findings[${i}].citations[${j}].utterance_id`),
        quote: text(co['quote'], CI_SCREENING_TEXT_MAX, `findings[${i}].citations[${j}].quote`),
      };
    });
    return { skill, observation, limitations, citations };
  });
  return { schema_version: CI_SCREENING_SCHEMA_VERSION, findings };
}

/** Whitespace-collapsed, case-insensitive (the same fidelity rule as the CI-B6 citation validator). */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface ResolvedScreeningCitation {
  readonly utterance_id: string;
  readonly start_offset: number;
  readonly end_offset: number;
}

/**
 * Re-validate every citation against the exact text the model was given (the
 * redacted utterances) and resolve COORDINATES against the stored normalized
 * utterance text. The quote is dropped. A citation to an unknown utterance is
 * CITATION_INVALID; a quote absent from the utterance is CITATION_SPAN_MISMATCH.
 * When the quote locates exactly in the stored text the span is that quote;
 * otherwise (e.g. it spans a redaction token) the span is the whole utterance —
 * never an invented position.
 */
export function resolveScreeningCitations(
  result: ScreeningAnalysisResultV1,
  sentText: ReadonlyMap<string, string>,
  storedText: ReadonlyMap<string, string>,
): ResolvedScreeningCitation[][] {
  return result.findings.map((f, i) =>
    f.citations.map((c, j) => {
      const sent = sentText.get(c.utterance_id);
      const stored = storedText.get(c.utterance_id);
      if (sent === undefined || stored === undefined) {
        throw new CiAnalysisValidationError(CI_PROCESSING_ERROR_CODES.CITATION_INVALID, `findings[${i}].citations[${j}] cites unknown utterance`);
      }
      if (!norm(sent).includes(norm(c.quote))) {
        throw new CiAnalysisValidationError(
          CI_PROCESSING_ERROR_CODES.CITATION_SPAN_MISMATCH,
          `findings[${i}].citations[${j}] quote not found in utterance`,
        );
      }
      const at = stored.toLowerCase().indexOf(c.quote.trim().toLowerCase());
      return at >= 0
        ? { utterance_id: c.utterance_id, start_offset: at, end_offset: at + c.quote.trim().length }
        : { utterance_id: c.utterance_id, start_offset: 0, end_offset: stored.length };
    }),
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * The run-identity hash of a screening context: the selected question plan, the
 * recruiter notes, the minimized talent profile, the meeting interaction and the
 * Requisition snapshot id, canonicalized (sorted keys). Any change → a new hash
 * → a NEW run; processing refuses a run whose context no longer matches.
 */
export function screeningContextSha256(context: ScreeningAnalysisContext, snapshotId: string | null): string {
  const body = JSON.stringify(
    canonical({
      session_id: context.session_id,
      talent_record_id: context.talent_record_id,
      interaction_id: context.interaction_id,
      question_plan: context.question_plan,
      recruiter_notes: context.recruiter_notes,
      talent_profile: context.talent_profile,
      requisition_snapshot_id: snapshotId,
    }),
  );
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
