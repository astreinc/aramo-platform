import { Injectable } from '@nestjs/common';

// Domain-Enforcement P3 §5 — rate limit for the session-less delegate routes.
// Fixed windows keyed per source IP AND per token hash (the SignupBudget /
// VerificationConfirmBudget convention). SCALING CAVEAT: in-memory and
// per-process — correct on the single box; a multi-instance deployment needs a
// shared store or the budget is per replica.

export const DELEGATE_BUDGET_WINDOW_MS = 10 * 60 * 1000;
export const DELEGATE_BUDGET_MAX_PER_IP = 30;
export const DELEGATE_BUDGET_MAX_PER_TOKEN = 20;

@Injectable()
export class DelegateBudget {
  private readonly windows = new Map<string, { start: number; count: number }>();

  // Returns true if `key` may proceed within its window budget of `max`.
  allow(key: string, max: number, now: number): boolean {
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= DELEGATE_BUDGET_WINDOW_MS) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= max) return false;
    w.count += 1;
    return true;
  }

  reset(): void {
    this.windows.clear();
  }
}
