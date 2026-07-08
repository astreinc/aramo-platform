import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Injectable,
  Ip,
  Post,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { TalentTrustService } from '@aramo/talent-trust';

import { hashVerificationToken } from '../talent-identity/verification-token.js';

// TR-3 B2 (§3.2) — the PUBLIC email-verification confirm endpoint.
//
// POST /v1/email-verifications/confirm  { token }
//
// DELIBERATELY UN-GUARDED (the public-invitation precedent): the talent has NO
// JWT — they arrive from an email link, not a session. NO @UseGuards. The ONLY
// authority is the high-entropy single-use token in the body (hash-matched
// server-side). It inherits the app's filter / request-id / validation.
//
// ORACLE-RESISTANT (DDR §2.4). Every non-success path — a bad token, an expired
// token, an already-consumed token, a rotated ("revoked") token, a missing
// token, OR an over-budget IP — returns ONE indistinguishable not-found-class
// response: the SAME code (NOT_FOUND), the SAME status (404), the SAME body
// (modulo the always-random request_id). An attacker probing tokens learns
// NOTHING about which of these occurred — not even whether a token existed. The
// FE renders a single generic failure state to match.
//
// The success shape (200 { status:'VERIFIED' }) is naturally distinguishable
// from failure — that is fine and intended: the anti-oracle is that the FOUR+
// FAILURE modes are indistinguishable FROM EACH OTHER, not that success hides.

// Per-IP budget (engine constants). A fixed small window caps confirm attempts
// per source IP so the endpoint cannot be used as a token-guessing oracle at
// volume. SCALING CAVEAT: this counter is IN-MEMORY and PER-PROCESS — correct on
// the single-box posture (§3.2), but a multi-instance deployment needs a shared
// store (Redis fixed-window) or the budget is per-replica. Documented, not hidden.
const CONFIRM_BUDGET_MAX_PER_WINDOW = 10;
const CONFIRM_BUDGET_WINDOW_MS = 60_000;

interface IpWindow {
  windowStart: number;
  count: number;
}

// An injectable singleton so the confirm controller resolves ONE shared budget
// map per process (and so it is overridable/resettable in tests, and available
// to a future operational reset). Not exported from any lib — apps/api-internal.
@Injectable()
export class VerificationConfirmBudget {
  private readonly windows = new Map<string, IpWindow>();

  // Returns true if this IP may proceed; false once it has spent its window
  // budget. Fixed-window: the first hit of a new window resets the count.
  allow(ip: string, nowMs: number): boolean {
    const existing = this.windows.get(ip);
    if (
      existing === undefined ||
      nowMs - existing.windowStart >= CONFIRM_BUDGET_WINDOW_MS
    ) {
      this.windows.set(ip, { windowStart: nowMs, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= CONFIRM_BUDGET_MAX_PER_WINDOW;
  }

  // Clear all windows. Used to isolate the shared per-process counter between
  // integration tests (each test owns its own budget); also a natural seam for
  // a future operational "unblock this box" op.
  reset(): void {
    this.windows.clear();
  }
}

@Controller('v1/email-verifications')
export class PublicVerificationController {
  constructor(
    private readonly trust: TalentTrustService,
    private readonly budget: VerificationConfirmBudget,
  ) {}

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Body() body: unknown,
    @Ip() ip: string,
    @RequestId() requestId: string,
  ): Promise<{ status: 'VERIFIED' }> {
    // Budget first — an over-budget IP is refused with the SAME not-found the
    // invalid-token paths return (it must not reveal that it was rate-limited).
    if (!this.budget.allow(ip ?? 'unknown', Date.now())) {
      throw notFound(requestId);
    }

    const raw = extractToken(body);
    // A missing/malformed token is FOLDED into the same not-found (no "you sent
    // no token" signal — the request either carries a valid secret or it does not).
    if (raw === null) throw notFound(requestId);

    const result = await this.trust.confirmEmailVerification(
      hashVerificationToken(raw),
    );
    // EVERY invalid state (bad/expired/consumed/rotated) surfaces as verified:
    // false → the one not-found. Only a live token yields 200 VERIFIED.
    if (!result.verified) throw notFound(requestId);

    return { status: 'VERIFIED' };
  }
}

// The single not-found-class response every failure returns. Constant code +
// constant message + empty details → byte-identical bodies (modulo request_id).
function notFound(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'verification not found', 404, {
    requestId,
  });
}

function extractToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const token = (body as Record<string, unknown>)['token'];
  if (typeof token !== 'string' || token.trim().length === 0) return null;
  return token;
}
