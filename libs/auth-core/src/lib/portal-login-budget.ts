import { Injectable } from '@nestjs/common';

// Portal P1 — the passwordless-login rate limiter. Modeled on the TR-3
// VerificationConfirmBudget (apps/api/.../public-verification.controller.ts) —
// the only rate-limit convention in the codebase. A fixed-window counter keyed
// on the REQUESTER (IP), applied UNIFORMLY at the top of both the request-link
// and consume handlers BEFORE any eligibility/token branch, so the limiter never
// leaks whether an email was eligible or a token valid (oracle-resistance extends
// to the limiter — the standing lesson).
//
// CAVEAT (inherited from the TR-3 budget): the counter is in-memory / per-process
// — correct only on the single-box posture. A multi-instance deploy needs a
// shared store (Redis fixed-window) or the budget is per-replica. Backlog with
// the TR-3 budget's identical caveat.

const PORTAL_LOGIN_BUDGET_MAX_PER_WINDOW = 10;
const PORTAL_LOGIN_BUDGET_WINDOW_MS = 60_000;

interface Window {
  count: number;
  windowStartMs: number;
}

@Injectable()
export class PortalLoginBudget {
  private readonly windows = new Map<string, Window>();

  /**
   * True if the requester (keyed by `key`, e.g. IP) is within budget for the
   * current fixed window; increments the counter. Uniform — never branches on
   * eligibility.
   */
  allow(key: string, nowMs: number): boolean {
    const existing = this.windows.get(key);
    if (existing === undefined || nowMs - existing.windowStartMs >= PORTAL_LOGIN_BUDGET_WINDOW_MS) {
      this.windows.set(key, { count: 1, windowStartMs: nowMs });
      return true;
    }
    if (existing.count >= PORTAL_LOGIN_BUDGET_MAX_PER_WINDOW) return false;
    existing.count += 1;
    return true;
  }

  /** Test isolation only. */
  reset(): void {
    this.windows.clear();
  }
}
