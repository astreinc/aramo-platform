import {
  ASSERTION_ADMISSION_CLASS,
  isAuthoritativeWorkAuthorization,
  type AssertionType,
  type IdentifierVerification as WireVerification,
  type TalentIngestRequest,
} from '@aramo/intelligence-contracts';

import type { ResolutionIdentifier, ResolutionInput } from '../identity/identity-resolution.service.js';
import {
  canonicalJson,
  normalizeEmail,
  normalizeNames,
  normalizePhone,
  sha256Hex,
  type GovIdTokenizer,
} from '../normalize.js';
import type { JsonObject, JsonValue } from '../repositories/types.js';

// ATI-SEP-1 T2 — map a VALIDATED TalentIngestRequest to (a) the identity
// resolution input and (b) the assertion drafts of this snapshot. Pure.

export interface AssertionDraft {
  assertion_type: AssertionType;
  admission_class: 'A' | 'B';
  payload: JsonObject;
  source_kind: string;
  observed_at: Date;
  valid_from: Date | null;
  valid_to: Date | null;
  ai_derived: boolean;
  source_document_hash: string | null;
  content_hash: string;
}

function verificationOf(v: WireVerification | undefined): Partial<ResolutionIdentifier> & { verified: boolean } {
  if (v?.status !== 'VERIFIED') return { verified: false };
  return {
    verified: true,
    ...(v.method ? { verification_method: v.method } : {}),
    ...(v.source ? { verification_source: v.source } : {}),
    ...(v.verified_at ? { verified_at: new Date(v.verified_at) } : {}),
  };
}

/** Raw government identifiers are tokenized HERE and never leave this function. */
export function toResolutionInput(req: TalentIngestRequest, tokenizer: GovIdTokenizer): ResolutionInput {
  const identifiers: ResolutionIdentifier[] = [];
  for (const e of req.identity.emails ?? []) {
    identifiers.push({
      identifier_type: 'EMAIL',
      normalized_value: normalizeEmail(e.value),
      is_primary: e.is_primary,
      ...verificationOf(e.verification),
    });
  }
  for (const p of req.identity.phones ?? []) {
    identifiers.push({
      identifier_type: 'PHONE',
      normalized_value: normalizePhone(p.value),
      is_primary: p.is_primary,
      ...verificationOf(p.verification),
    });
  }
  for (const g of req.identity.government_ids ?? []) {
    identifiers.push({
      identifier_type: 'GOV_ID',
      normalized_value: tokenizer.token(g.jurisdiction, g.identifier_class, g.value),
      jurisdiction: g.jurisdiction.toUpperCase(),
      identifier_class: g.identifier_class.toUpperCase(),
      is_primary: false,
      ...verificationOf(g.verification),
    });
  }
  return {
    tuple: {
      source_system_id: req.source_system_id,
      source_tenant_id: req.source_tenant_id,
      external_talent_id: req.external_talent_id,
    },
    names: normalizeNames(req.identity.names),
    identifiers,
  };
}

function trimDeep(value: unknown): JsonValue {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(trimDeep);
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = trimDeep(v);
    }
    return out;
  }
  return value as JsonValue;
}

/** Content hash: everything that makes an assertion "the same claim" — NOT observed_at. */
export function assertionContentHash(d: Omit<AssertionDraft, 'content_hash' | 'observed_at' | 'admission_class'>): string {
  return sha256Hex(
    canonicalJson({
      assertion_type: d.assertion_type,
      payload: d.payload,
      source_kind: d.source_kind,
      valid_from: d.valid_from?.toISOString() ?? null,
      valid_to: d.valid_to?.toISOString() ?? null,
      ai_derived: d.ai_derived,
      source_document_hash: d.source_document_hash,
    }),
  );
}

function draft(base: Omit<AssertionDraft, 'content_hash' | 'admission_class'>): AssertionDraft {
  return {
    ...base,
    admission_class: ASSERTION_ADMISSION_CLASS[base.assertion_type],
    content_hash: assertionContentHash(base),
  };
}

/**
 * The assertion drafts of one snapshot, de-duplicated by content hash. The
 * identity names become one Class B NAME assertion (source_kind RECRUITER — the
 * identity block is the source system's own record). A WORK_AUTHORIZATION
 * payload gains a TI-computed `authoritative` flag (TI-1G: résumé-sourced or
 * AI-derived values are non-authoritative; the sender's label is never trusted).
 */
export function toAssertionDrafts(req: TalentIngestRequest): AssertionDraft[] {
  const out = new Map<string, AssertionDraft>();
  const names = req.identity.names;
  if (names && (names.first || names.last || (names.aliases?.length ?? 0) > 0)) {
    const d = draft({
      assertion_type: 'NAME',
      payload: trimDeep(names) as JsonObject,
      source_kind: 'RECRUITER',
      observed_at: new Date(req.occurred_at),
      valid_from: null,
      valid_to: null,
      ai_derived: false,
      source_document_hash: null,
    });
    out.set(d.content_hash, d);
  }
  for (const a of req.assertions) {
    const ai = a.ai_derived ?? false;
    let payload = trimDeep(a.payload) as JsonObject;
    if (a.assertion_type === 'WORK_AUTHORIZATION') {
      payload = { ...payload, authoritative: isAuthoritativeWorkAuthorization(a.source_kind, ai) };
    }
    const d = draft({
      assertion_type: a.assertion_type,
      payload,
      source_kind: a.source_kind,
      observed_at: new Date(a.observed_at),
      valid_from: a.valid_from ? new Date(a.valid_from) : null,
      valid_to: a.valid_to ? new Date(a.valid_to) : null,
      ai_derived: ai,
      source_document_hash: a.provenance?.source_document_hash ?? null,
    });
    if (!out.has(d.content_hash)) out.set(d.content_hash, d);
  }
  return [...out.values()];
}

/** Single-valued facts: a newly added assertion SUPERSEDES the retired one of the same type. */
export const SINGLE_VALUED_ASSERTION_TYPES: ReadonlySet<string> = new Set([
  'NAME',
  'CURRENT_EMPLOYER',
  'TITLE',
  'LOCATION',
  'AVAILABILITY',
  'WORK_AUTHORIZATION',
]);
