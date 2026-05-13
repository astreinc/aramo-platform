// PR-8.0a-Reground §7. RefreshTokenDto is the public surface returned by
// RefreshTokenService methods. ISO-string timestamps; never raw Prisma rows
// (per ADR-0001 service convention).

export interface RefreshTokenDto {
  id: string;
  user_id: string;
  tenant_id: string;
  consumer_type: string;
  token_hash: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by_id: string | null;
}
