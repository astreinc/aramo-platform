// Locked at 6 fields per directive §8.5 SE.3.g and openapi/auth.yaml.
// `actor_kind` is intentionally NOT surfaced (carried in the JWT payload
// only; libs/auth's AuthContext shape stays at 6 fields).

export interface SessionResponseDto {
  sub: string;
  consumer_type: 'recruiter' | 'portal' | 'ingestion';
  tenant_id: string;
  scopes: string[];
  iat: number;
  exp: number;
}
