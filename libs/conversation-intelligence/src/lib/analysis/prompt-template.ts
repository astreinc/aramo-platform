// CI-B6 — the versioned, deterministic prompt template (directive §prompt-design).
// Static instructions are separate from the evidence payload; the template's
// sha256 is recorded on every run for provenance/repro. A wording change REQUIRES
// a version bump (which changes the analysis-identity key → a NEW run, never a
// silent overwrite). This is the instruction contract a real provider adapter
// would combine with the transcript + Requisition-snapshot evidence.

import { createHash } from 'node:crypto';

import { CI_ANALYSIS_SCHEMA_VERSION } from './analysis-schema.js';

export const CI_PROMPT_TEMPLATE_ID = 'conversation-intelligence.analysis';
export const CI_PROMPT_TEMPLATE_VERSION = 'v1';

/**
 * The static instruction block. It explicitly binds the model to evidence-only,
 * statement-not-fact, no-inference, no-ordering, no-recommendation, cite-every-
 * material-claim, no-protected-trait, discussed-unclear-vs-not-discussed, and
 * schema-only behaviour (directive §11-§17). Evidence is supplied separately.
 */
export const CI_PROMPT_TEMPLATE_TEXT = [
  'You produce evidence-grounded conversation-intelligence output for recruiter review.',
  'Use ONLY the provided normalized transcript and the provided immutable Requisition analysis context. Do not use outside knowledge.',
  'Transcript statements are evidence of what was SAID — they are NOT objective facts. Represent them as claims about what the speaker stated, never as verified real-world truth.',
  'Do NOT infer missing information. If a topic was not discussed, mark it NOT_DISCUSSED. If it was discussed but unclear, mark it DISCUSSED_UNCLEAR.',
  'Do NOT produce any numeric ordering, fit metric, suitability measure, hiring recommendation, or comparison between people. Do NOT decide hire or no-hire.',
  'Do NOT infer or extract protected or sensitive attributes (e.g. race, religion, disability, medical, pregnancy, political, genetic, national origin).',
  'Cite transcript evidence for every material claim: reference the exact utterance_id and the quoted excerpt from that utterance. A material claim without a citation is invalid.',
  'Ground requirement-related claims against the provided Requisition context keys only. Do not invent requirements that are not present.',
  'Distinguish what the recruiter or Talent said they WOULD do (a commitment) from what actually happened (which you cannot assert).',
  `Return ONLY a JSON object matching schema ${CI_ANALYSIS_SCHEMA_VERSION}. Emit no prose outside the schema and no extra keys.`,
].join('\n');

/** SHA-256 (hex) of the static template — recorded on every run for provenance. */
export const CI_PROMPT_TEMPLATE_SHA256 = createHash('sha256')
  .update(CI_PROMPT_TEMPLATE_TEXT, 'utf8')
  .digest('hex');
