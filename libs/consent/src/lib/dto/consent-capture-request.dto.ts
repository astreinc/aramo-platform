import { ArrayNotEmpty, IsArray, IsIn, IsUUID } from 'class-validator';

// The recruiter-driven consent CAPTURE surface (ats-web Add-Talent post-create
// step + the Talent-360 Contactability "Record consent" action). Distinct from
// the single-scope /consent/grant (which trusts a caller-supplied version/text)
// and the portal self-service path: /consent/capture renders + hashes the
// versioned consent text SERVER-SIDE (no FE-owned legal text) and records the
// affirmatively-selected profile scopes through the one authoritative writer.
//
// Restricted to the three profile scopes that govern recruiter contactability.
// resume_processing / cross_tenant_visibility are out of this increment (no
// approved recruiter-capture wording for them — fail-closed).
export const CONSENT_CAPTURE_SCOPES = [
  'profile_storage',
  'matching',
  'contacting',
] as const;
export type ConsentCaptureScopeValue = (typeof CONSENT_CAPTURE_SCOPES)[number];

// Two attestation methods, each bound to its OWN versioned consent text:
//   self_signup       — "Talent directly": first-person portal-consent-v1 (approved).
//   recruiter_capture — "Recruiter records the Talent's authorization":
//                        recruiter-capture-v1-draft (provisional, pending legal).
// Both are existing CONSENT_CAPTURED_METHODS values; this is the narrowed set the
// capture endpoint accepts.
export const CONSENT_CAPTURE_METHODS = ['self_signup', 'recruiter_capture'] as const;
export type ConsentCaptureMethodValue = (typeof CONSENT_CAPTURE_METHODS)[number];

export class ConsentCaptureRequestDto {
  @IsUUID()
  talent_record_id!: string;

  @IsIn(CONSENT_CAPTURE_METHODS)
  captured_method!: ConsentCaptureMethodValue;

  // The scopes the recruiter affirmatively attested. Server validates the set is
  // dependency-closed (profile_storage -> matching -> contacting) and records
  // ONLY these scopes (never auto-adds an unattested scope).
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(CONSENT_CAPTURE_SCOPES, { each: true })
  scopes!: ConsentCaptureScopeValue[];
}
