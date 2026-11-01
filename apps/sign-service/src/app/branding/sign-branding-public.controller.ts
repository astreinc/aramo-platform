import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { EnvelopeAlreadyExecutedError, EsignService, SigningSessionExpiredError, SigningSessionInvalidError } from '@aramo/sign';
import type { Response } from 'express';

import { SignBrandingService, type SignerBrandingView } from './sign-branding.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.10 — the guest (session-less)
// branding routes, inside the guest signing zone:
//   POST v1/sign/signing/branding              { token } → the sending organization's branding
//                                              for the signer page, or null (Aramo default).
//                                              The capability token is the only authority;
//                                              no tenant id is returned.
//   GET  v1/sign/signing/brand-logo/:logo_id   the logo image (PNG/JPEG) for the signing page
//                                              and the notification emails. The id is random
//                                              per upload; served only while branding applies.
// DARK: while `sign.branding` is NOT_AVAILABLE the first answers { branding: null } and the
// second 404 — no database read.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/sign/signing')
@UseFilters(AramoExceptionFilter)
export class SignBrandingPublicController {
  constructor(
    private readonly branding: SignBrandingService,
    // The capability token resolves through the engine (as every signer route does).
    private readonly esign: EsignService,
  ) {}

  @Post('branding')
  @HttpCode(HttpStatus.OK)
  async signerBranding(@Body() body: { token?: unknown }, @RequestId() requestId: string): Promise<{ branding: SignerBrandingView | null }> {
    const token = body?.token;
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
      throw new AramoError('VALIDATION_ERROR', 'token is required', 400, { requestId, details: { field: 'token' } });
    }
    try {
      // Dark: no token lookup and no store read while the feature is not available.
      if (!this.branding.available()) return { branding: null };
      const ctx = await this.esign.resolveSession(token);
      return { branding: await this.branding.forSigner(ctx.tenant_id) };
    } catch (e) {
      // A token that no longer signs simply gets the default look (the page shows its own
      // end state from the signing routes).
      if (e instanceof SigningSessionInvalidError || e instanceof SigningSessionExpiredError || e instanceof EnvelopeAlreadyExecutedError) return { branding: null };
      throw e;
    }
  }

  @Get('brand-logo/:logo_id')
  async logo(@Param('logo_id') logo_id: string, @RequestId() requestId: string, @Res() res: Response): Promise<void> {
    const logo = UUID_RE.test(logo_id) ? await this.branding.publicLogo(logo_id) : null;
    if (logo === null) throw new AramoError('NOT_FOUND', 'Logo not found', 404, { requestId });
    res.setHeader('Content-Type', logo.content_type);
    res.setHeader('Content-Length', String(logo.bytes.byteLength));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('ETag', `"${logo.sha256}"`);
    res.status(200).end(Buffer.from(logo.bytes));
  }
}
