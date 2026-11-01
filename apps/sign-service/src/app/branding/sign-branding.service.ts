import { Injectable, Optional } from '@nestjs/common';
import {
  SignBrandingRepository,
  signBaseUrl,
  type BrandingLogoBytes,
  type CertificateBranding,
  type SignBrandingPort,
  type StoredBranding,
} from '@aramo/sign';
import { ESIGN_ENVELOPE_ALLOWANCE, SIGN_PRODUCT_KEY, SubscriptionLifecycleService } from '@aramo/subscription';

import { SIGN_BRANDING_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — Branding and customization.
//
// Branding is APPLIED (signing pages, notification emails, execution certificate) only when
// BOTH hold, checked server-side on every use:
//   1. launch availability — `sign.branding` is AVAILABLE (NOT_AVAILABLE in this build: dark,
//      R-8; flipping it is a separate PO authorization), and
//   2. plan entitlement — the tenant's open Sign subscription's PINNED plan version enables
//      the `sign.branding` feature (placement B+: Business, Professional, Enterprise).
// Otherwise every surface keeps the default Aramo look. When the feature is not available
// nothing is read for recipients (no query on the signing / email / certificate paths).

/** The public logo route (sign-service, under the guest signing zone). */
export function brandingLogoPath(logo_id: string): string {
  return `/v1/sign/signing/brand-logo/${logo_id}`;
}

export interface EffectiveBranding {
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  logo: { logo_id: string; content_type: 'image/png' | 'image/jpeg'; sha256: string; width: number; height: number } | null;
}

/** What a signer page receives (no tenant id, no internal ids beyond the public logo path). */
export interface SignerBrandingView {
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  logo_url: string | null;
}

function isEmpty(b: StoredBranding): boolean {
  return b.display_name === null && b.primary_color === null && b.accent_color === null && b.logo === null;
}

@Injectable()
export class SignBrandingService implements SignBrandingPort {
  constructor(
    private readonly repo: SignBrandingRepository,
    // Optional so narrow compositions keep working; absent ⇒ the production registry.
    @Optional() private readonly gate?: SignFeatureGate,
    // Absent ⇒ no tenant is entitled (branding never applies).
    @Optional() private readonly lifecycle?: SubscriptionLifecycleService,
  ) {}

  /** Launch availability of `sign.branding` (no database read). */
  available(): boolean {
    return (this.gate ?? new SignFeatureGate()).isAvailable(SIGN_BRANDING_FEATURE);
  }

  /** The tenant's open Sign subscription's pinned plan version enables `sign.branding`. */
  async entitled(tenant_id: string): Promise<boolean> {
    if (this.lifecycle === undefined) return false;
    try {
      const view = await this.lifecycle.account(tenant_id, SIGN_PRODUCT_KEY, ESIGN_ENVELOPE_ALLOWANCE);
      const sub = view.subscription;
      if (sub === null || sub.ended_at !== null || sub.status === 'CANCELED') return false;
      return sub.features.some((f) => f.feature_key === SIGN_BRANDING_FEATURE && f.enabled);
    } catch {
      return false;
    }
  }

  async stored(tenant_id: string): Promise<StoredBranding | null> {
    return this.repo.get(tenant_id);
  }

  /** The branding to apply for this tenant, or null for the default Aramo look. */
  async effective(tenant_id: string): Promise<EffectiveBranding | null> {
    if (!this.available()) return null;
    if (!(await this.entitled(tenant_id))) return null;
    const b = await this.repo.get(tenant_id);
    if (b === null || isEmpty(b)) return null;
    return {
      display_name: b.display_name,
      primary_color: b.primary_color,
      accent_color: b.accent_color,
      logo: b.logo === null ? null : { logo_id: b.logo.logo_id, content_type: b.logo.content_type, sha256: b.logo.sha256, width: b.logo.width, height: b.logo.height },
    };
  }

  /** SignBrandingPort — the certificate letterhead (logo bytes read only when applied). */
  async certificateBranding(tenant_id: string): Promise<CertificateBranding | null> {
    const b = await this.effective(tenant_id);
    if (b === null) return null;
    const logo = b.logo === null ? null : await this.repo.logoOfTenant(tenant_id);
    if (b.display_name === null && logo === null) return null;
    return {
      display_name: b.display_name,
      primary_color: b.primary_color,
      logo: logo === null ? null : { bytes: logo.bytes, format: logo.content_type === 'image/png' ? 'PNG' : 'JPG', sha256: logo.sha256 },
    };
  }

  /** The signer-page branding of the tenant a signing token resolved to, or null. */
  async forSigner(tenant_id: string): Promise<SignerBrandingView | null> {
    const b = await this.effective(tenant_id);
    return b === null ? null : signerView(b);
  }

  /** A public logo by id — served only while that tenant's branding applies. */
  async publicLogo(logo_id: string): Promise<BrandingLogoBytes | null> {
    if (!this.available()) return null;
    const logo = await this.repo.logoById(logo_id);
    if (logo === null) return null;
    const b = await this.effective(logo.tenant_id);
    if (b === null || b.logo === null || b.logo.logo_id !== logo_id) return null;
    return logo;
  }
}

export function signerView(b: EffectiveBranding): SignerBrandingView {
  return {
    display_name: b.display_name,
    primary_color: b.primary_color,
    accent_color: b.accent_color,
    logo_url: b.logo === null ? null : brandingLogoPath(b.logo.logo_id),
  };
}

/** The absolute logo address for an email, or null without a configured Sign origin. */
export function emailLogoUrl(b: EffectiveBranding, env: NodeJS.ProcessEnv = process.env): string | null {
  if (b.logo === null) return null;
  const origin = signBaseUrl(env);
  return origin === null ? null : `${origin}${brandingLogoPath(b.logo.logo_id)}`;
}
