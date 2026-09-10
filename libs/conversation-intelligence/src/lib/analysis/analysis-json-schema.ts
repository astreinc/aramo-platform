// CI-B6P — the provider-NEUTRAL JSON-Schema representation of the
// conversation-intelligence.analysis.v1 contract (directive §8). This is a
// plain JSON Schema object (NOT a vendor SDK type), so it lives in the CI
// domain and keeps the output contract authoritative here — any production
// model provider is handed this exact schema for native structured output.
//
// IMPORTANT: provider-native schema enforcement is a FIRST pass only, never
// domain authority. The strict allowlist validator (analysis-validator) and
// the citation validator remain the sole authority over what becomes a
// completed CI run (directive §8/§25). This schema is built from the same
// status vocabulary + allowed-key constants so the two never drift.

import { CI_CLAIM_STATUSES } from '../domain/run-enums.js';

import { CI_ANALYSIS_SCHEMA_VERSION } from './analysis-schema.js';

/** A stable name for the structured-output format (provider "schema name"). */
export const CI_ANALYSIS_JSON_SCHEMA_NAME = 'conversation_intelligence_analysis_v1';

/**
 * JSON Schema for analysis.v1. `additionalProperties: false` + explicit
 * `required` mirror the strict allowlist — the provider is asked to emit ONLY
 * the permitted shape (so a volunteered ordering / fit / recommendation /
 * confidence field is refused at the provider boundary too), but the domain
 * validator is still run afterward and is authoritative.
 */
export const CI_ANALYSIS_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'claims', 'draft'],
  properties: {
    schema_version: { type: 'string', const: CI_ANALYSIS_SCHEMA_VERSION },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim_type', 'statement', 'status', 'citations'],
        properties: {
          claim_type: { type: 'string', minLength: 1 },
          context_ref: { type: 'string' },
          statement: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: [...CI_CLAIM_STATUSES] },
          citations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['utterance_id', 'quote'],
              properties: {
                utterance_id: { type: 'string', minLength: 1 },
                quote: { type: 'string' },
                start_offset: { type: 'integer', minimum: 0 },
                end_offset: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
    },
    draft: {
      type: 'object',
      additionalProperties: false,
      required: ['sections'],
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'items'],
            properties: {
              key: { type: 'string', minLength: 1 },
              items: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
} as const;
