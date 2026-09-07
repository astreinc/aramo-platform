// CI-B3 — conversation-transcript domain errors (lib-local, mirrors the
// communications domain/errors.ts pattern; NOT the shared error-code registry —
// B3 exposes no API surface, so no cross-service error code is registered).

import type { TranscriptState } from './transcript-enums.js';

/** Illegal transcript acquisition state transition. */
export class TranscriptInvalidStateError extends Error {
  readonly from: TranscriptState;
  readonly to: TranscriptState;
  constructor(from: TranscriptState, to: TranscriptState) {
    super(`Illegal transcript transition: ${from} -> ${to}`);
    this.name = 'TranscriptInvalidStateError';
    this.from = from;
    this.to = to;
  }
}

/**
 * The referenced CommunicationInteraction does not exist within the tenant.
 * Tenant-safe: a wrong-tenant interaction is "does not exist" for this caller
 * (directive §3.1 — Communications keeps interaction authority; §28 tenant
 * isolation). Carries NO interaction detail beyond the id echoed by the caller.
 */
export class TranscriptInteractionNotFoundError extends Error {
  readonly tenantId: string;
  readonly interactionId: string;
  constructor(tenantId: string, interactionId: string) {
    super('Referenced CommunicationInteraction not found in tenant');
    this.name = 'TranscriptInteractionNotFoundError';
    this.tenantId = tenantId;
    this.interactionId = interactionId;
  }
}

/**
 * A different provider transcript resource was presented for an aggregate that
 * is already bound to another provider reference (provenance conflict). Protects
 * the immutable (provider_key, provider_transcript_id) identity.
 */
export class TranscriptProviderReferenceConflictError extends Error {
  constructor(message = 'Transcript provider reference conflict') {
    super(message);
    this.name = 'TranscriptProviderReferenceConflictError';
  }
}

/**
 * Transcription was not authorized for this acquisition (directive §4.5 —
 * fail-closed). B3 does NOT evaluate consent; it requires the composition root
 * to supply an already-authorized command. Absence of proof fails closed.
 */
export class TranscriptAcquisitionNotAuthorizedError extends Error {
  constructor(message = 'Transcription is not authorized for this interaction') {
    super(message);
    this.name = 'TranscriptAcquisitionNotAuthorizedError';
  }
}
