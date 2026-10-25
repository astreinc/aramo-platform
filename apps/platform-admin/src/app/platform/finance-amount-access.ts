import type { AuthContextType } from '@aramo/auth';
import { financeAmountAccess } from '@aramo/subscription';

// CCP-R3 — Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0 (LOCKED) FA-1 / FA-5: the
// field-authorization decision of every platform-admin mapper that can carry a tenant-specific
// monetary figure (C3 billing status, C6 outstanding payments, A3 change requests, A2 audit
// events, the B5 audit export). Read from the server-resolved scopes of THIS request
// (JwtAuthGuard), never from a client hint: platform:billing:read AND platform:billing:amount:read.
export function amountAccess(auth: Pick<AuthContextType, 'scopes'>): boolean {
  return financeAmountAccess(auth.scopes);
}
