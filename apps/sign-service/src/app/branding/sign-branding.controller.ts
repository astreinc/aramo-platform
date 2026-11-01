import { Body, Controller, Delete, Get, Put, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, EsignSenderBoundary } from '@aramo/identity';
import {
  BRANDING_LOGO_MAX_BYTES,
  SignBrandingRepository,
  normalizeBrandColor,
  normalizeDisplayName,
  validateBrandingLogo,
  type LogoRejection,
  type StoredBranding,
} from '@aramo/sign';

import { ESIGN_READ_SCOPE } from '../sender/sender-context.service.js';

import { SignBrandingService, brandingLogoPath } from './sign-branding.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — Settings → Branding.
//   GET    branding        any workspace reader (`can_edit` tells the console)
//   PUT    branding        sign:settings:manage (sign_admin): display name + colours
//   PUT    branding/logo   sign:settings:manage: a PNG or JPEG (base64 JSON, ≤ 256 KiB)
//   DELETE branding/logo   sign:settings:manage
// DARK: every write answers 403 ESIGN_FEATURE_NOT_AVAILABLE while `sign.branding` is
// NOT_AVAILABLE (reason feature_not_available), or when the tenant's plan does not include
// branding (reason plan_not_entitled). The read then reports available/entitled false.

// Base64 of the largest accepted logo (4 chars per 3 bytes, padded).
const MAX_BASE64_LENGTH = Math.ceil(BRANDING_LOGO_MAX_BYTES / 3) * 4;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface BrandingView {
  available: boolean;
  entitled: boolean;
  can_edit: boolean;
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  logo: { url: string; content_type: string; byte_size: number; width: number; height: number } | null;
  updated_at: string | null;
}

function viewOf(b: StoredBranding | null, state: { available: boolean; entitled: boolean; can_edit: boolean }): BrandingView {
  return {
    ...state,
    display_name: b?.display_name ?? null,
    primary_color: b?.primary_color ?? null,
    accent_color: b?.accent_color ?? null,
    logo:
      b?.logo == null
        ? null
        : { url: brandingLogoPath(b.logo.logo_id), content_type: b.logo.content_type, byte_size: b.logo.byte_size, width: b.logo.width, height: b.logo.height },
    updated_at: b?.updated_at.toISOString() ?? null,
  };
}

function bad(requestId: string, message: string, reason: string, field?: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason, ...(field !== undefined ? { field } : {}) } });
}

// Optional text: absent or null ⇒ null (the Aramo default); otherwise it must normalise.
function optional(raw: unknown, normalize: (v: unknown) => string | null, requestId: string, field: string, message: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = normalize(raw);
  if (v === null) throw bad(requestId, message, `invalid_${field}`, field);
  return v;
}

@Controller('v1/sign/sender')
@UseFilters(AramoExceptionFilter)
export class SignBrandingController {
  constructor(
    private readonly branding: SignBrandingService,
    private readonly repo: SignBrandingRepository,
  ) {}

  @Get('branding')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  async get(@AuthContext() auth: AuthContextType): Promise<BrandingView> {
    const available = this.branding.available();
    if (!available) return viewOf(null, { available: false, entitled: false, can_edit: false });
    const entitled = await this.branding.entitled(auth.tenant_id);
    const can_edit = entitled && auth.scopes.includes(ESIGN_SCOPE.SETTINGS_MANAGE);
    return viewOf(await this.repo.get(auth.tenant_id), { available, entitled, can_edit });
  }

  @Put('branding')
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  async put(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Body() body: { display_name?: unknown; primary_color?: unknown; accent_color?: unknown },
  ): Promise<BrandingView> {
    await this.assertWritable(auth, requestId);
    const display_name = optional(body?.display_name, normalizeDisplayName, requestId, 'display_name', 'display_name must be 1 to 80 printable characters (letters, digits, punctuation)');
    const primary_color = optional(body?.primary_color, normalizeBrandColor, requestId, 'primary_color', 'primary_color must be a #RRGGBB colour');
    const accent_color = optional(body?.accent_color, normalizeBrandColor, requestId, 'accent_color', 'accent_color must be a #RRGGBB colour');
    const saved = await this.repo.setSettings(auth.tenant_id, { display_name, primary_color, accent_color }, auth.sub);
    return viewOf(saved, { available: true, entitled: true, can_edit: true });
  }

  @Put('branding/logo')
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  async putLogo(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { content_type?: unknown; data_base64?: unknown }): Promise<BrandingView> {
    await this.assertWritable(auth, requestId);
    const data = body?.data_base64;
    if (typeof data !== 'string' || data.length === 0) throw bad(requestId, 'data_base64 is required', 'logo_empty', 'data_base64');
    if (data.length > MAX_BASE64_LENGTH) throw bad(requestId, 'The logo must be 256 KB or smaller', 'logo_too_large', 'data_base64');
    if (data.length % 4 !== 0 || !BASE64_RE.test(data)) throw bad(requestId, 'data_base64 is not valid base64', 'logo_encoding_invalid', 'data_base64');
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    const checked = validateBrandingLogo(bytes, body?.content_type);
    if (!checked.ok) throw bad(requestId, LOGO_MESSAGES[checked.reason], checked.reason, 'data_base64');
    const saved = await this.repo.setLogo(auth.tenant_id, bytes, checked.image.content_type, auth.sub);
    return viewOf(saved, { available: true, entitled: true, can_edit: true });
  }

  @Delete('branding/logo')
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  async deleteLogo(@AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<BrandingView> {
    await this.assertWritable(auth, requestId);
    const saved = await this.repo.clearLogo(auth.tenant_id, auth.sub);
    return viewOf(saved, { available: true, entitled: true, can_edit: true });
  }

  // Availability first (an unavailable feature is unavailable to everyone), then the plan.
  private async assertWritable(auth: AuthContextType, requestId: string): Promise<void> {
    if (!this.branding.available()) {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'This feature is not available in Aramo Sign yet', 403, {
        requestId,
        details: { feature_key: 'sign.branding', reason: 'feature_not_available' },
      });
    }
    if (!(await this.branding.entitled(auth.tenant_id))) {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Branding is not included in your plan', 403, {
        requestId,
        details: { feature_key: 'sign.branding', reason: 'plan_not_entitled' },
      });
    }
  }
}

const LOGO_MESSAGES: Record<LogoRejection, string> = {
  logo_empty: 'The logo file is empty',
  logo_too_large: 'The logo must be 256 KB or smaller',
  logo_type_unsupported: 'The logo must be a PNG or JPEG image',
  logo_type_mismatch: 'The logo file does not match its declared type',
  logo_dimensions_invalid: 'The logo must be between 16 and 4096 pixels on each side',
};
