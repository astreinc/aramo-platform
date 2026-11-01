// Commercial Plans Amendment A1 review — a plan's ENTITLEMENT (what the
// catalog says the plan includes) is kept apart from the capability's LAUNCH
// AVAILABILITY (whether it is built and operational). The catalog keeps the
// approved entitlements; anything not available is never advertised as
// delivered. Moving a key to AVAILABLE is a governed change made when the
// capability ships.

export type FeatureAvailability = 'AVAILABLE' | 'NOT_AVAILABLE';

export const FEATURE_AVAILABILITY: Readonly<Record<string, FeatureAvailability>> = {
  // Sending envelopes for signature (the Sign engine).
  'sign.envelopes': 'AVAILABLE',
  // Per-tenant storage allocation (enforced at upload).
  'sign.storage_bytes': 'AVAILABLE',
  // Shared organization workspace: several users with Sign roles see and act on
  // the organization's envelopes (PX-1 business workspace, role-based access).
  'sign.team_collaboration': 'AVAILABLE',
  // Aramo-Sign-Unified-Product-Amendment-M-A5 §3.7 — hosted (in-person) signing.
  // Available wherever Sign sending is available unless the PO restricts it.
  'sign.in_person_signing': 'AVAILABLE',
  // Not built: the console shows templates as a future capability (PX-V1 §15);
  // there is no forms feature; no AI summary exists for Sign.
  'sign.templates': 'NOT_AVAILABLE',
  'sign.forms': 'NOT_AVAILABLE',
  'sign.ai_assist_summary': 'NOT_AVAILABLE',
  'sign.advanced_analytics': 'NOT_AVAILABLE',
  'sign.custom_domain': 'NOT_AVAILABLE',
  // Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — per-organization branding
  // (logo, colours, sender display name on signing pages, emails and the certificate). Built
  // DARK: flipping it to AVAILABLE is a separate PO authorization (R-8).
  'sign.branding': 'NOT_AVAILABLE',
  // Aramo Sign Feature-Parity §1.21 — organization-defined Sign roles (Professional,
  // Enterprise). Built DARK: every custom-role route refuses with ESIGN_FEATURE_NOT_AVAILABLE
  // until the PO authorizes the flip (R-8).
  'sign.custom_roles': 'NOT_AVAILABLE',
  // Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.18 — RFC 3161 trusted
  // timestamps. Built dark: sign-service binds a TSA only when this is AVAILABLE and
  // SIGN_TSA_URL is set. Flipping it is a PO decision (R-8), after the TSA contract (D-3).
  'sign.trusted_timestamp': 'NOT_AVAILABLE',
  // Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5) §1.17 / §1.9 — built
  // dark (R-8): witness signing and delegate signing (Business and up), and the
  // per-recipient access code (every plan, including Free). Moving any of them to
  // AVAILABLE is a separate PO authorization.
  'sign.witness_signing': 'NOT_AVAILABLE',
  'sign.delegate_signing': 'NOT_AVAILABLE',
  'sign.access_code': 'NOT_AVAILABLE',
  // Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.7 / §1.8 / §1.9 (Amendment A1)
  // — built dark: SMS and WhatsApp delivery of the signing link and SMS one-time-code
  // recipient verification. Each moves to AVAILABLE only with a separate PO authorization
  // after its vendor contract, registration (10DLC / DLT / Meta templates) and counsel
  // review (A1.2). Server-side gated like sign.templates (SignFeatureGate).
  'sign.sms_delivery': 'NOT_AVAILABLE',
  'sign.whatsapp_delivery': 'NOT_AVAILABLE',
  'sign.sms_otp': 'NOT_AVAILABLE',
  // Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.9 + Amendment A1 — recipient
  // identity verification by government ID (Stripe Identity) and KBA (no vendor selected).
  // Built dark; going live needs the vendor contract, counsel review (BIPA/DPDP) and a
  // separate PO authorization (A1.2).
  'sign.id_verification': 'NOT_AVAILABLE',
  'sign.kba': 'NOT_AVAILABLE',
};

/** Unknown keys are not available (never advertise what is not registered). */
export function isFeatureAvailable(key: string, registry: Readonly<Record<string, FeatureAvailability>> = FEATURE_AVAILABILITY): boolean {
  return registry[key] === 'AVAILABLE';
}
