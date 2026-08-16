import { ApiError } from '@aramo/fe-foundation';

// Track 7 / T7-P5 §8 — governed error → actionable, non-leaking UI copy for the permanent
// guarantee lifecycle flows. Maps the exact backend ErrorCodes the user flows can hit; the raw
// internal reason string is never surfaced when a safe mapped message exists. Unknown shapes
// fall back to a generic retry message (fail-closed).

function reasonOf(err: unknown): string | undefined {
  if (err instanceof ApiError && err.details !== null && typeof err.details === 'object') {
    const r = (err.details as Record<string, unknown>)['reason'];
    return typeof r === 'string' ? r : undefined;
  }
  return undefined;
}

// The replacement-evidence backend reasons (validateCompletionEvidence) → user-safe guidance.
const REPLACEMENT_REASON_COPY: Record<string, string> = {
  replacement_placement_process_id_required: 'Enter the replacement placement reference.',
  replacement_must_differ_from_original: 'The replacement must be a different placement.',
  replacement_not_found: 'That placement could not be found. Check the reference and try again.',
  replacement_wrong_requisition: 'The replacement must be on the same requisition.',
  replacement_not_permanent: 'The replacement must be a permanent placement.',
  replacement_not_started: 'The replacement placement must have started.',
  external_reference_not_allowed_for_replacement: 'A settlement reference is not used for a replacement remedy.',
  external_reference_required: 'Enter a completion evidence reference.',
  external_reference_too_long: 'The completion evidence reference is too long.',
  replacement_id_not_allowed_for_monetary_remedy: 'A replacement reference is not used for this remedy.',
};

export function satisfyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // A PREMATURE satisfy (before the guarantee end date) is the governed
    // PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID (422) — NOT STATE_INVALID. (Confirmed
    // against the provider: permanent-placement.repository throws GUARANTEE_WINDOW_INVALID
    // when today < guarantee_end_date.)
    if (err.code === 'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID') {
      return 'This guarantee cannot be satisfied yet — it can only be satisfied on or after the guarantee end date.';
    }
    // A genuinely illegal transition (e.g. the guarantee is already terminal).
    if (err.code === 'PERMANENT_PLACEMENT_STATE_INVALID') {
      return 'This guarantee can no longer be satisfied.';
    }
  }
  return 'Could not satisfy the guarantee. Please try again.';
}

export function falloffErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'PERMANENT_PLACEMENT_FALLOFF_WINDOW_INVALID') {
      return 'The effective date must fall within the guarantee window (on or after the start, before the end).';
    }
    if (err.code === 'PERMANENT_PLACEMENT_FALLOFF_REASON_INVALID') {
      return 'Choose a governed falloff reason.';
    }
    if (err.code === 'PERMANENT_PLACEMENT_STATE_INVALID') {
      return 'A falloff can only be recorded while the guarantee is active.';
    }
  }
  return 'Could not record the falloff. Please try again.';
}

export function remedyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'PERMANENT_PLACEMENT_REMEDY_ALREADY_COMPLETED') {
      return 'This remedy obligation has already been completed.';
    }
    if (err.code === 'PERMANENT_PLACEMENT_REMEDY_INVALID') {
      const reason = reasonOf(err);
      if (reason !== undefined && REPLACEMENT_REASON_COPY[reason] !== undefined) {
        return REPLACEMENT_REASON_COPY[reason];
      }
      return 'The completion evidence is invalid. Please check it and try again.';
    }
    if (err.code === 'PERMANENT_PLACEMENT_STATE_INVALID') {
      return 'This placement is not awaiting a remedy.';
    }
  }
  return 'Could not complete the remedy. Please try again.';
}
