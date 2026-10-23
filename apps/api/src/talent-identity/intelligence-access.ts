import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { EntitlementRepository } from '@aramo/entitlement';
import {
  IntelligenceClient,
  IntelligenceNotConfiguredError,
  IntelligenceRejectedError,
  IntelligenceUnavailableError,
} from '@aramo/intelligence-integration';

// ATI-SEP-1 T10 WP3b — the ATS recruiter trust surfaces read Talent Intelligence
// (TI) through the HTTP client ONLY, and TI is ENRICHMENT: the ATS works when TI
// is not configured, the tenant does not hold the `intelligence` capability, or
// TI is down. Every surface carries `intelligence_status`:
//
//   ENABLED        — TI configured, tenant entitled, the call answered.
//   NOT_ENTITLED   — the tenant does not hold `intelligence` (ATS or TI side).
//   NOT_CONFIGURED — INTELLIGENCE_SERVICE_URL / client credentials unset.
//   UNAVAILABLE    — TI unreachable / timed out / 5xx / an unexpected refusal.
//
// Reads (`read`) NEVER throw: the surface renders an absent enrichment. Actions
// (`act`) — a human disposing a TI work item — have nothing to fall back to, so
// they refuse with a typed ATS error (never a 500): INTELLIGENCE_UNAVAILABLE 503
// with details.intelligence_status, or the mapped TI refusal. No ATS decision
// (create / update / pipeline / submittal) ever routes through here.

export const INTELLIGENCE_STATUSES = ['ENABLED', 'NOT_ENTITLED', 'NOT_CONFIGURED', 'UNAVAILABLE'] as const;
export type IntelligenceStatus = (typeof INTELLIGENCE_STATUSES)[number];

export type IntelligenceRead<T> =
  | { status: 'ENABLED'; value: T }
  /** TI answered 404 (unknown / erased reference or item): enabled, nothing to show. */
  | { status: 'ENABLED'; value: null }
  | { status: Exclude<IntelligenceStatus, 'ENABLED'>; value: null };

/** TI lifecycle / verification refusal code → the ATS error code + HTTP status it surfaces as. */
const REFUSAL_MAP: Record<string, { code: ConstructorParameters<typeof AramoError>[0]; status: number }> = {
  INVALID_REQUEST: { code: 'VALIDATION_ERROR', status: 400 },
  RESOLUTION_NOT_PERMITTED: { code: 'INSUFFICIENT_PERMISSIONS', status: 403 },
  REFERENCE_NOT_FOUND: { code: 'NOT_FOUND', status: 404 },
  NOT_FOUND: { code: 'NOT_FOUND', status: 404 },
  VERIFICATION_NOT_FOUND: { code: 'NOT_FOUND', status: 404 },
  PROPOSAL_NOT_OPEN: { code: 'PROPOSAL_NOT_OPEN', status: 409 },
  ASSERTION_NOT_DISPUTABLE: { code: 'EVIDENCE_NOT_DISPUTABLE', status: 422 },
  ASSERTION_NOT_CONTRADICTED: { code: 'EVIDENCE_NOT_CONTRADICTED', status: 422 },
  DISPUTE_NOT_OPEN: { code: 'PORTAL_DISPUTE_NOT_OPEN', status: 422 },
  DISPUTE_NOT_UNDER_REVIEW: { code: 'PORTAL_DISPUTE_NOT_OPEN', status: 422 },
  DISPUTE_EXTENSION_USED: { code: 'PORTAL_DISPUTE_EXTENSION_USED', status: 422 },
  INVALID_CODE: { code: 'IDENTIFIER_VERIFICATION_REFUSED', status: 422 },
  VERIFICATION_EXPIRED: { code: 'IDENTIFIER_VERIFICATION_REFUSED', status: 422 },
  VERIFICATION_LOCKED: { code: 'IDENTIFIER_VERIFICATION_REFUSED', status: 422 },
  ALREADY_CONFIRMED: { code: 'IDENTIFIER_VERIFICATION_REFUSED', status: 422 },
};

export function intelligenceUnavailable(requestId: string, status: Exclude<IntelligenceStatus, 'ENABLED'>): AramoError {
  const message =
    status === 'UNAVAILABLE' ? 'Talent Intelligence is unavailable' : 'Talent Intelligence is not enabled for this workspace';
  return new AramoError('INTELLIGENCE_UNAVAILABLE', message, 503, { requestId, details: { intelligence_status: status } });
}

/** Map a TI client failure onto the ATS error envelope. Never yields a 500. */
export function intelligenceError(err: unknown, requestId: string): AramoError {
  if (err instanceof AramoError) return err;
  if (err instanceof IntelligenceNotConfiguredError) return intelligenceUnavailable(requestId, 'NOT_CONFIGURED');
  if (err instanceof IntelligenceRejectedError) {
    if (err.code === 'NOT_ENTITLED') return intelligenceUnavailable(requestId, 'NOT_ENTITLED');
    const mapped = REFUSAL_MAP[err.code];
    if (mapped !== undefined) {
      const details: Record<string, unknown> = { reason: err.code };
      if (typeof err.details['attempts_remaining'] === 'number') details['attempts_remaining'] = err.details['attempts_remaining'];
      // 404s stay uniform: no detail distinguishes "unknown" from "not yours".
      return mapped.status === 404
        ? new AramoError('NOT_FOUND', 'not found', 404, { requestId })
        : new AramoError(mapped.code, err.message, mapped.status, { requestId, details });
    }
    return intelligenceUnavailable(requestId, 'UNAVAILABLE');
  }
  if (err instanceof IntelligenceUnavailableError) return intelligenceUnavailable(requestId, 'UNAVAILABLE');
  return intelligenceUnavailable(requestId, 'UNAVAILABLE');
}

@Injectable()
export class IntelligenceAccess {
  constructor(
    readonly client: IntelligenceClient,
    private readonly entitlements: EntitlementRepository,
  ) {}

  /** The local gate: configured + the tenant's `intelligence` capability. */
  async gate(tenantId: string): Promise<IntelligenceStatus> {
    if (!this.client.configured) return 'NOT_CONFIGURED';
    try {
      const caps = await this.entitlements.getCapabilities(tenantId);
      return caps.has('intelligence') ? 'ENABLED' : 'NOT_ENTITLED';
    } catch {
      return 'UNAVAILABLE';
    }
  }

  /** An enrichment read. Never throws. */
  async read<T>(tenantId: string, fn: (client: IntelligenceClient) => Promise<T>): Promise<IntelligenceRead<T>> {
    const gate = await this.gate(tenantId);
    if (gate !== 'ENABLED') return { status: gate, value: null };
    try {
      return { status: 'ENABLED', value: await fn(this.client) };
    } catch (err) {
      if (err instanceof IntelligenceNotConfiguredError) return { status: 'NOT_CONFIGURED', value: null };
      if (err instanceof IntelligenceRejectedError) {
        if (err.status === 404) return { status: 'ENABLED', value: null };
        if (err.code === 'NOT_ENTITLED') return { status: 'NOT_ENTITLED', value: null };
      }
      return { status: 'UNAVAILABLE', value: null };
    }
  }

  /** A human action on a TI work item. Throws a mapped AramoError (never a 500). */
  async act<T>(tenantId: string, requestId: string, fn: (client: IntelligenceClient) => Promise<T>): Promise<T> {
    const gate = await this.gate(tenantId);
    if (gate !== 'ENABLED') throw intelligenceUnavailable(requestId, gate);
    try {
      return await fn(this.client);
    } catch (err) {
      throw intelligenceError(err, requestId);
    }
  }
}
