import { IsIn, IsOptional, IsString } from 'class-validator';
import { CONSENT_SCOPES, type ConsentScopeValue } from '@aramo/consent';

// Portal P2 P2a (Directive §PR-1.2) — the portal-actor consent grant/revoke
// request/response envelopes. Engagement-class (ruling 1): a consent flow names
// its recipient tenant — these are NOT trust-class (never in TRUST_CLASS_SCHEMAS).
//
// The request carries ONLY the scope (+ optionally the consent-text version the
// UI rendered). The record id comes from the OPEN-4 chain (the path :id resolved
// through membership), NEVER the body — no "who" oracle. The actor (PortalUser.id)
// and the term/expiry are server-derived.

export class PortalConsentGrantRequestDto {
  @IsIn(CONSENT_SCOPES)
  scope!: ConsentScopeValue;

  // The consent-text version the portal user saw (the D7 hash preimage). Optional —
  // defaults to the current version server-side.
  @IsOptional()
  @IsString()
  consent_text_version?: string;
}

export class PortalConsentRevokeRequestDto {
  @IsIn(CONSENT_SCOPES)
  scope!: ConsentScopeValue;

  @IsOptional()
  @IsString()
  consent_text_version?: string;
}

// The closed portal mutation envelope (openapi/portal.yaml PortalConsentMutation).
export interface PortalConsentMutationDto {
  scope: ConsentScopeValue;
  action: 'granted' | 'revoked';
  occurred_at: string;
  expires_at: string | null;
}
