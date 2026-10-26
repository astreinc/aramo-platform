import type { AuthContextType } from '@aramo/auth';
import { AramoError } from '@aramo/common';
import { financeAmountAccess, withholdProviderText, type FinanceReader } from '@aramo/subscription';

// CCP-R3 — Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0 (LOCKED) FA-1 / FA-5: the
// field-authorization decision of every platform-admin mapper that can carry a tenant-specific
// monetary figure (C3 billing status, C6 outstanding payments, A3 change requests, A2 audit
// events, the B5 audit export). Read from the server-resolved scopes of THIS request
// (JwtAuthGuard), never from a client hint: platform:billing:read AND platform:billing:amount:read.
export function amountAccess(auth: Pick<AuthContextType, 'scopes'>): boolean {
  return financeAmountAccess(auth.scopes);
}

// CCP-R3-W (Architect W-2 / W-3) — the same decision plus the caller's own principal, for the
// requester exception of W-3 (a financial request's requester reads their own reason and
// evidence). The principal is the verified token subject; a non-user caller is never a requester.
export function financeReader(auth: Pick<AuthContextType, 'scopes' | 'sub' | 'actor_kind'>): FinanceReader {
  return { amount_access: financeAmountAccess(auth.scopes), user_id: auth.actor_kind === 'user' ? auth.sub : null };
}

// CCP-R3-W item 3 (TD-MERGE-43 residual) — a refusal / failure mapped to HTTP keeps its code,
// refusal and explanation, but provider-derived free text in its details (`error`, `message`, …)
// reaches only a holder of the Finance amount scope; a non-holder gets `detail_withheld`.
export function withholdErrorProviderText(err: unknown, amount_access: boolean): unknown {
  if (amount_access || !(err instanceof AramoError) || err.context.details === undefined) return err;
  return new AramoError(err.code, err.message, err.statusCode, { ...err.context, details: withholdProviderText(err.context.details, false) });
}
