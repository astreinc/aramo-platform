import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ZoomWebhookService } from './zoom-webhook.service.js';
import {
  ZOOM_WEBHOOK_SIGNATURE_HEADER,
  ZOOM_WEBHOOK_TIMESTAMP_HEADER,
} from './zoom-webhook.constants.js';

// COMM-B6 — the Zoom Phone inbound webhook (POST /v1/webhooks/communications/zoom).
//
// DELIBERATELY UN-GUARDED (like the Indeed webhook): Zoom calls this with NO
// Aramo session — there can be no JWT — so there is NO @UseGuards. The SOLE
// authority is the `x-zm-signature` HMAC-SHA256 over `v0:{timestamp}:{rawBody}`,
// verified in ZoomWebhookService against the app-level signing secret. Every
// outcome is a BARE HTTP status with no error-code envelope (external machine
// ingress, not the Aramo client error contract):
//   503 — webhook secret ref unresolvable (dark by construction)
//   401 — missing/invalid/stale signature (checked BEFORE tenant resolution)
//   400 — malformed body (post-authentication)
//   200 — endpoint.url_validation challenge response
//   204 — accepted (processed / dup / unsupported / unmatched / unknown account)
//
// The 204 is UNIFORM across processed and unknown-account/unmatched cases, so it
// carries no provider/account/tenant existence oracle (and only Zoom can produce
// a valid signature to reach it). The body arrives as a raw Buffer (the
// route-scoped raw parser in main.ts) so the HMAC covers the exact signed bytes;
// no @Body() DTO (a third party's payload the refusal-walker cannot bind).
@Controller('v1/webhooks/communications')
export class ZoomWebhookController {
  constructor(private readonly service: ZoomWebhookService) {}

  @Post('zoom')
  async zoom(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const outcome = await this.service.process({
      rawBody,
      timestamp: firstHeader(req.headers[ZOOM_WEBHOOK_TIMESTAMP_HEADER]) ?? '',
      signatureHeader: firstHeader(req.headers[ZOOM_WEBHOOK_SIGNATURE_HEADER]) ?? '',
      nowEpochSec: Math.floor(Date.now() / 1000),
    });

    res.status(outcome.status);
    // 200 (url_validation) carries the challenge body; every other outcome is a
    // bare status with an empty body.
    return outcome.status === 200 ? outcome.body : undefined;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
