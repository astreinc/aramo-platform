// COMM-V1 — LOCAL domain errors (COMM-B1). These are module-local domain errors,
// NOT entries in the central @aramo/common error-code registry. Mapping to the
// locked error envelope (COMMUNICATION_INVALID_STATE, etc.) is a COMM-B2 concern
// (append-LAST against the then-current registry tail per R-COMM-SYNC).

import type { CommunicationInteractionStatus } from './communication-enums.js';

/** Raised when a call-state transition is not permitted by the canonical machine. */
export class CommunicationInvalidStateError extends Error {
  readonly from: CommunicationInteractionStatus;
  readonly to: CommunicationInteractionStatus;

  constructor(from: CommunicationInteractionStatus, to: CommunicationInteractionStatus) {
    super(`illegal call-state transition: ${from} -> ${to}`);
    this.name = 'CommunicationInvalidStateError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Raised when an interaction is not found for the acting tenant. A cross-tenant
 * id is tenant-safe NOT FOUND (never an info leak) — the same error a missing id
 * yields, so tenant B cannot distinguish "exists for A" from "does not exist".
 */
export class CommunicationInteractionNotFoundError extends Error {
  readonly interaction_id: string;

  constructor(interactionId: string) {
    super('communication interaction not found');
    this.name = 'CommunicationInteractionNotFoundError';
    this.interaction_id = interactionId;
  }
}
