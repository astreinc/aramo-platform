// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — the branding the engine
// applies to the execution certificate. Bound by the composition root (sign-service), which
// decides feature availability and plan entitlement; unbound (or null) = the Aramo default.
// Never allowed to fail a completion: callers treat a throw as "no branding".

export const SIGN_BRANDING_PORT = Symbol('SIGN_BRANDING_PORT');

export interface CertificateBranding {
  // Printable Latin-1 (validated at write), drawn beside the logo, or as an
  // "Organization:" line when there is no logo.
  display_name: string | null;
  // The tenant's logo, PNG or JPEG.
  logo: { bytes: Uint8Array; format: 'PNG' | 'JPG'; sha256: string } | null;
  // `#RRGGBB` — the rule drawn under the letterhead.
  primary_color: string | null;
}

export interface SignBrandingPort {
  certificateBranding(tenant_id: string): Promise<CertificateBranding | null>;
}
