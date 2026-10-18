import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import type { Request, Response } from 'express';

import { ProviderCompletionService } from '../provider-completion.service.js';

import { ADOBE_SIGN_CLIENT_ID_HEADER } from './adobe-sign-webhook.js';
import { ADOBE_SIGN_CONFIG } from './adobe-sign.tokens.js';
import type { AdobeSignConfig } from './adobe-sign.config.js';

// Multi-Provider directive §G — Adobe Acrobat Sign webhook
// (GET|POST /v1/webhooks/esignature/adobe-sign). DELIBERATELY UN-GUARDED: Adobe
// calls with no Aramo session. Adobe's verification of intent: the request carries
// our client id in X-AdobeSign-ClientId and we echo it on success; any other id is
// refused (never 2xx). Because that is not a signature, the payload is a hint only
// (ProviderCompletionService confirms with the tenant's own Adobe token).
//   503 — Adobe Acrobat Sign not configured · 403 — foreign/missing client id
//   200 + echo — verified (processed, duplicate, not completed, unknown: uniform)
//   500 — transient failure while storing; Adobe retries
const logger = createAramoLogger('AdobeSignWebhookController');

function header(req: Request): string {
  const v = req.headers[ADOBE_SIGN_CLIENT_ID_HEADER];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

@Controller('v1/webhooks/esignature')
export class AdobeSignWebhookController {
  constructor(
    private readonly completion: ProviderCompletionService,
    @Optional() @Inject(ADOBE_SIGN_CONFIG) private readonly config: AdobeSignConfig | null,
  ) {}

  private gate(req: Request, res: Response): boolean {
    if (this.config === null || this.config === undefined) {
      res.status(503);
      return false;
    }
    if (header(req) !== this.config.clientId) {
      res.status(403);
      return false;
    }
    return true;
  }

  private echo(res: Response): { xAdobeSignClientId: string } {
    const id = this.config?.clientId ?? '';
    res.setHeader('X-AdobeSign-ClientId', id);
    res.status(200);
    return { xAdobeSignClientId: id };
  }

  @Get('adobe-sign')
  async verify(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ xAdobeSignClientId: string } | undefined> {
    if (!this.gate(req, res)) return undefined;
    return this.echo(res);
  }

  @Post('adobe-sign')
  async notify(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ xAdobeSignClientId: string } | undefined> {
    if (!this.gate(req, res)) return undefined;
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { event?: unknown; agreement?: { id?: unknown } };
    const agreementId = body.agreement?.id;
    if (body.event === 'AGREEMENT_WORKFLOW_COMPLETED' && typeof agreementId === 'string') {
      try {
        // The callback carries no account identity; the tenant binding is the route
        // plus the read with that tenant's own token.
        await this.completion.handle({ provider: 'adobe_sign', provider_account_id: null, envelope_ref: agreementId, requestId: randomUUID() });
      } catch (err) {
        logger.warn({ event: 'esignature.adobe_completion_failed', message: (err as Error).message });
        res.status(500);
        return undefined;
      }
    }
    return this.echo(res);
  }
}
