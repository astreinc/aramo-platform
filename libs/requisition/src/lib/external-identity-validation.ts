import { AramoError } from '@aramo/common';

import {
  isCanonicalSourceSystemKey,
  normalizeSourceSystem,
} from './dto/source-system.js';

// T8-P1 — canonical external-requisition identity resolution.
//
// The VMS canonical model (T8 VMS Integration Directive v1.0 §3–§5): the VMS is
// the external source; the Aramo Requisition is the canonical internal
// projection. The provenance seam is (source_system, external_req_id): a
// requisition's external identity is the triple (tenant_id, source_system,
// external_req_id), enforced by a partial unique index when BOTH provenance
// fields are present (Requisition_external_identity_key, T8-P1 migration).
//
// This module owns the WRITE-boundary canonicalization + validation so every
// write path (create / createForImport / update) stores a canonical value and
// rejects a malformed or partial external identity BEFORE persist. It is the
// throwing counterpart of the pure dto/source-system.ts (mirrors
// compensation-validation.ts, which imports AramoError; dto/ stays dep-light).

// Opaque provider requisition ids vary in shape; we do not constrain their
// content (case is provider-significant, so NOT lowercased), only reject blank
// and bound the length to the storable range.
export const MAX_EXTERNAL_REQ_ID_LENGTH = 255;

export interface ExternalIdentityInput {
  source_system?: string | null;
  external_req_id?: string | null;
}

export interface ResolvedExternalIdentity {
  source_system: string | null;
  external_req_id: string | null;
}

function reject(requestId: string, field: string, reason: string): never {
  throw new AramoError('VALIDATION_ERROR', `Invalid ${field}: ${reason}`, 400, {
    requestId,
    details: { field },
  });
}

// Canonicalize a supplied source_system, or null. Throws VALIDATION_ERROR (400)
// when the normalized value is not a canonical provider key.
export function canonicalizeSourceSystem(
  raw: string | null | undefined,
  requestId: string,
): string | null {
  if (raw === undefined || raw === null) return null;
  const normalized = normalizeSourceSystem(raw);
  if (!isCanonicalSourceSystemKey(normalized)) {
    reject(
      requestId,
      'source_system',
      'must be a canonical lowercase provider key (a-z, 0-9, single underscores)',
    );
  }
  return normalized;
}

// Trim + validate a supplied external_req_id, or null. Throws VALIDATION_ERROR
// (400) on a blank or over-length identifier. Case preserved (opaque).
export function validateExternalReqId(
  raw: string | null | undefined,
  requestId: string,
): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    reject(requestId, 'external_req_id', 'must not be blank');
  }
  if (trimmed.length > MAX_EXTERNAL_REQ_ID_LENGTH) {
    reject(
      requestId,
      'external_req_id',
      `must be at most ${MAX_EXTERNAL_REQ_ID_LENGTH} characters`,
    );
  }
  return trimmed;
}

// An external_req_id is namespaced by its provider — it has no meaning without a
// source_system. Reject an external id that lacks a (effective) source_system.
export function assertExternalIdentityCoPresence(
  effectiveSourceSystem: string | null,
  effectiveExternalReqId: string | null,
  requestId: string,
): void {
  if (effectiveExternalReqId !== null && effectiveSourceSystem === null) {
    reject(
      requestId,
      'external_req_id',
      'requires source_system (external identity is namespaced by provider)',
    );
  }
}

// Create-path resolver: canonicalize + validate + co-presence in one call,
// returning the canonical pair to persist.
export function resolveExternalIdentity(
  input: ExternalIdentityInput,
  requestId: string,
): ResolvedExternalIdentity {
  const source_system = canonicalizeSourceSystem(input.source_system, requestId);
  const external_req_id = validateExternalReqId(input.external_req_id, requestId);
  assertExternalIdentityCoPresence(source_system, external_req_id, requestId);
  return { source_system, external_req_id };
}
