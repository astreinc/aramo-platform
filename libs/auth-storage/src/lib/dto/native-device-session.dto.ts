// AUTH-SIGNIN-1 Amendment M-A1 §3.6 — the public surface of a server-owned
// native device session. ISO-string timestamps; never raw Prisma rows (ADR-0001
// service convention, same as RefreshTokenDto).

export const NATIVE_PLATFORMS = ['ios', 'android'] as const;
export type NativePlatform = (typeof NATIVE_PLATFORMS)[number];

export interface NativeDeviceSessionDto {
  id: string;
  user_id: string;
  tenant_id: string;
  consumer_type: string;
  client_id: string;
  installation_id: string;
  platform: NativePlatform;
  app_version: string;
  refresh_family_root_id: string;
  current_refresh_token_id: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

// The outcome of recording an authorization code in the redeemed-code ledger.
export type CodeRedemptionOutcome = 'redeemed' | 'code_already_redeemed' | 'nonce_replayed';
