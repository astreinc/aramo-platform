import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequestId } from '@aramo/common';

import { IndeedApplyWebhookService } from './indeed-apply.service.js';
import { INDEED_SIGNATURE_HEADER } from './indeed-signature.js';

// SRC-1 PR-2 — the Indeed Apply inbound webhook (POST /v1/webhooks/indeed/apply).
//
// DELIBERATELY UN-GUARDED (mirrors PublicTenantCertController / the public-token
// controllers): Indeed calls this endpoint with NO Aramo session — there can be
// no JWT — so there is NO @UseGuards here. The SOLE authority is the
// `X-Indeed-Signature` HMAC over the raw request body, verified in
// IndeedApplyWebhookService against the partner-provisioned secret (R5). Every
// non-200 outcome is a bare HTTP status with NO body detail:
//   503 — webhook secret unset (dark by construction until SRC-2 turns it on)
//   401 — missing/invalid signature (checked BEFORE tenant resolution, so the
//         404 below is not an unauthenticated tenant-enumeration oracle)
//   404 — unknown/inactive tenant slug (Host → slug, RECON-3a primitives)
//   400 — malformed payload (not JSON / no apply_id)
//
// R6 — wildcard tenant host only. The Caddyfile proxies `/v1/*` on the wildcard
// tenant site (audit E3) so this route is reachable there with ZERO Caddy change;
// the admin and portal hosts have no `/v1/*` (or only `/v1/portal/*`) route, so
// they cannot reach it. Tenant is resolved from the request Host slug.
//
// R10 — no @Body() DTO: the inbound shape is a third party's payload, which the
// refusal-walker's `additionalProperties:false` cannot bind. The body arrives as
// a raw Buffer (the route-scoped raw parser in main.ts) so the HMAC covers the
// exact bytes Indeed signed; the consumed-field subset is validated in the
// service, not by class-validator.
@Controller('v1/webhooks/indeed')
export class IndeedApplyController {
  constructor(private readonly service: IndeedApplyWebhookService) {}

  @Post('apply')
  async apply(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @RequestId() requestId: string,
  ): Promise<{ received: boolean } | undefined> {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    const signatureHeader = firstHeader(req.headers[INDEED_SIGNATURE_HEADER]);
    // Caddy forwards the original host; prefer the forwarded header, fall back to
    // Host. Both are lowercased by Node's HTTP layer.
    const host =
      firstHeader(req.headers['x-forwarded-host']) ??
      firstHeader(req.headers['host']);

    const outcome = await this.service.process({
      rawBody,
      signatureHeader,
      host,
      requestId,
    });

    res.status(outcome.status);
    if (outcome.status === 200) {
      return { received: true };
    }
    // Non-200 → bare status, empty body.
    return undefined;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
