import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER,
  INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER,
} from '@aramo/intelligence-contracts';
import { IntelligenceWebhookReceiver } from '@aramo/intelligence-integration';

// ATI-SEP-1 T8 (ADR-0036 §3 "TI → ATS") — POST /v1/integrations/intelligence/events.
//
// DELIBERATELY UN-GUARDED (no user session — the platform's signature-verified
// webhook precedent): the SOLE authority is the aramo-intelligence-webhook-v1
// HMAC over the RAW body (INTELLIGENCE_WEBHOOK_SIGNING_SECRET, ±300 s).
//   401 — secret unset, signature missing / stale / invalid (fail closed)
//   400 — malformed golden_talent.profile_updated body
//   202 — recorded in the inbox (the worker's inbound sync applies it)
//   200 — a replay of an already-recorded event_id (idempotent no-op)
//   5xx — the inbox write failed → TI redelivers from its own outbox
// Nothing here reads TI or writes a TalentRecord: the request path stays a
// single idempotent inbox insert.
@Controller('v1/integrations/intelligence')
export class IntelligenceEventsController {
  constructor(private readonly receiver: IntelligenceWebhookReceiver) {}

  @Post('events')
  async events(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ received: true; event_id: string; duplicate?: true } | undefined> {
    const result = await this.receiver.receive({
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.from([]),
      timestampHeader: firstHeader(req.headers[INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER]),
      signatureHeader: firstHeader(req.headers[INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER]),
    });
    res.status(result.status);
    return result.body;
  }
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
