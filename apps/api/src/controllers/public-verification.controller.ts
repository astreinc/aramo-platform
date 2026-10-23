import { Body, Controller, HttpCode, HttpStatus, Injectable, Ip, Post } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { VERIFICATION_CODE_LENGTH, isUuid } from '@aramo/intelligence-contracts';
import { IntelligenceClient } from '@aramo/intelligence-integration';

import { intelligenceError } from '../talent-identity/intelligence-access.js';

// TR-3 B2 → ATI-SEP-1 T10 WP3b (Addendum A3 T10-3) — the PUBLIC email
// verification confirm endpoint: a 6-digit one-time code minted and checked by
// Talent Intelligence.
//
// POST /v1/email-verifications/confirm  { verification_id, code }
//   → TI POST /v1/verifications/:verification_id/confirm { code }
//
// DELIBERATELY UN-GUARDED (PZ — public, session-less first-party): the talent
// has NO session; they arrive from the emailed link (?verification_id=…) and
// type the code from the same email. The authority is the code, checked by TI,
// which enforces the TTL (VERIFICATION_TTL_SECONDS) and the attempt budget
// (VERIFICATION_MAX_ATTEMPTS, then LOCKED). The code is relayed and never logged
// or stored here.
//
// Refusals:
//   404 NOT_FOUND                         unknown verification id / over the per-IP budget (uniform)
//   400 VALIDATION_ERROR                  not a UUID id / not a 6-digit code
//   422 IDENTIFIER_VERIFICATION_REFUSED   details.reason INVALID_CODE (+ attempts_remaining) |
//                                         VERIFICATION_EXPIRED | VERIFICATION_LOCKED | ALREADY_CONFIRMED
//   503 INTELLIGENCE_UNAVAILABLE          TI not configured / unreachable
// Success: 200 { status: 'VERIFIED' } — the TI binding outcome stays internal
// (a public caller never learns about another subject).

// Per-IP budget. A fixed small window caps confirm attempts per source IP (TI's
// per-verification attempt budget is the second line). SCALING CAVEAT: the
// counter is IN-MEMORY and PER-PROCESS — correct on the single-box posture; a
// multi-instance deployment needs a shared store or the budget is per-replica.
const CONFIRM_BUDGET_MAX_PER_WINDOW = 10;
const CONFIRM_BUDGET_WINDOW_MS = 60_000;
const CODE_PATTERN = new RegExp(`^\\d{${VERIFICATION_CODE_LENGTH}}$`);

interface IpWindow {
  windowStart: number;
  count: number;
}

// An injectable singleton so the confirm controller resolves ONE shared budget
// map per process (overridable / resettable in tests).
@Injectable()
export class VerificationConfirmBudget {
  private readonly windows = new Map<string, IpWindow>();

  allow(ip: string, nowMs: number): boolean {
    const existing = this.windows.get(ip);
    if (existing === undefined || nowMs - existing.windowStart >= CONFIRM_BUDGET_WINDOW_MS) {
      this.windows.set(ip, { windowStart: nowMs, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= CONFIRM_BUDGET_MAX_PER_WINDOW;
  }

  reset(): void {
    this.windows.clear();
  }
}

@Controller('v1/email-verifications')
export class PublicVerificationController {
  constructor(
    private readonly client: IntelligenceClient,
    private readonly budget: VerificationConfirmBudget,
  ) {}

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(@Body() body: unknown, @Ip() ip: string, @RequestId() requestId: string): Promise<{ status: 'VERIFIED' }> {
    // Budget first — an over-budget IP gets the SAME not-found an unknown id does.
    if (!this.budget.allow(ip ?? 'unknown', Date.now())) throw notFound(requestId);

    const { verificationId, code } = extract(body);
    if (verificationId === null || code === null) {
      throw new AramoError('VALIDATION_ERROR', 'verification_id (uuid) and a 6-digit code are required', 400, {
        requestId,
        details: { invalid_field: verificationId === null ? 'verification_id' : 'code' },
      });
    }
    try {
      await this.client.confirmVerification(verificationId, code);
    } catch (err) {
      throw intelligenceError(err, requestId);
    }
    return { status: 'VERIFIED' };
  }
}

function notFound(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'not found', 404, { requestId });
}

function extract(body: unknown): { verificationId: string | null; code: string | null } {
  if (typeof body !== 'object' || body === null) return { verificationId: null, code: null };
  const b = body as Record<string, unknown>;
  const id = b['verification_id'];
  const code = b['code'];
  return {
    verificationId: typeof id === 'string' && isUuid(id) ? id : null,
    code: typeof code === 'string' && CODE_PATTERN.test(code) ? code : null,
  };
}
