// ExternalIdentityDto — public shape of the ExternalIdentity mapping.
// Maps (provider, provider_subject) → User; does not auto-create User
// during runtime auth (directive §3).
export interface ExternalIdentityDto {
  id: string;
  provider: string;
  provider_subject: string;
  user_id: string;
  email_snapshot: string | null;
  created_at: string;
  updated_at: string;
}
