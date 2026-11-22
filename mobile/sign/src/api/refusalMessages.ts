// User-facing copy for refusals, keyed by `reason` (directive §7 dispositions win over
// the handoff). Feature screens may render richer UI for a reason (e.g. the reminder
// cooldown time); this is the shared fallback text. Never includes server prose.
//
// Client Rule Consolidation C3 (audit row 29) — the map itself lives ONCE in
// @aramo/sign-client (REFUSAL_COPY): the web shows the same words. This module adapts the
// app's ApiError to it.
import { REFUSAL_COPY, WORD_COPY, refusalMessage as sharedRefusal } from '@aramo/sign-client';

import { dateTime } from '../features/inbox/agreementsModel';
import type { ApiError } from './errors';

export { WORD_COPY };

// M-A11 §1: builds without native signup still point to the web.
export const NO_ACCOUNT_WEB =
  'There’s no Aramo account for this sign-in. Create one at sign.aramo.ai, or try the other sign-in option.';

/** True when the shared map has copy for this reason or code. */
export function hasRefusalCopy(key: string): boolean {
  return REFUSAL_COPY[key] !== undefined;
}

export function refusalMessage(
  error: Pick<ApiError, 'reason' | 'code'> & Partial<Pick<ApiError, 'status' | 'details'>>,
): string {
  return sharedRefusal(
    {
      code: error.code,
      reason: error.reason,
      ...(error.status !== undefined ? { status: error.status } : {}),
      details: error.details ?? null,
    },
    { time: (iso) => dateTime(iso) || null },
  );
}
