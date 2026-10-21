import { AramoError } from '@aramo/common';

import type { RequisitionHoldDetails } from './requisition-lifecycle-event.store.js';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §6.2 (S3, A1 AM-3) — the manual hold
// details on a PATCH. Pure: validates the `hold` control payload against the edge the PATCH is
// taking and returns the event-row details (or undefined when the edge is not a hold).
//   * PUT_ON_HOLD → reason + source REQUIRED (VALIDATION_ERROR `hold_details_required`);
//     `source: 'vms'` is refused here — only the integration seam records 'vms' (§6.3).
//   * any other edge (or no status change) carrying `hold` → `hold_details_not_applicable`.
export const MANUAL_HOLD_SOURCES = ['client', 'internal'] as const;

export interface ManualHoldInput {
  readonly reason?: string;
  readonly source?: string;
  readonly effective_at?: string;
  readonly instructions?: string | null;
}

function refuse(reason: string, requestId: string, field?: string): never {
  throw new AramoError('VALIDATION_ERROR', 'Invalid hold details', 400, {
    requestId,
    details: field === undefined ? { reason } : { reason, field },
  });
}

export function resolveManualHoldDetails(args: {
  readonly is_put_on_hold: boolean;
  readonly hold: ManualHoldInput | undefined;
  readonly now: Date;
  readonly requestId: string;
}): RequisitionHoldDetails | undefined {
  const { hold, requestId } = args;
  if (!args.is_put_on_hold) {
    if (hold !== undefined && hold !== null) refuse('hold_details_not_applicable', requestId);
    return undefined;
  }
  if (hold === undefined || hold === null || typeof hold !== 'object') {
    refuse('hold_details_required', requestId);
  }
  const reason = typeof hold.reason === 'string' ? hold.reason.trim() : '';
  if (reason === '') refuse('hold_details_required', requestId, 'reason');
  if (hold.source === undefined || hold.source === null || hold.source === '') {
    refuse('hold_details_required', requestId, 'source');
  }
  if (!(MANUAL_HOLD_SOURCES as readonly string[]).includes(hold.source)) {
    refuse('hold_source_not_allowed', requestId, 'source');
  }
  let effective_at = args.now;
  if (hold.effective_at !== undefined && hold.effective_at !== null) {
    const parsed = new Date(hold.effective_at);
    if (typeof hold.effective_at !== 'string' || Number.isNaN(parsed.getTime())) {
      refuse('hold_effective_at_invalid', requestId, 'effective_at');
    }
    effective_at = parsed;
  }
  const instructions =
    typeof hold.instructions === 'string' && hold.instructions.trim() !== '' ? hold.instructions.trim() : null;
  return {
    reason,
    source: hold.source as 'client' | 'internal',
    effective_at,
    instructions,
  };
}
