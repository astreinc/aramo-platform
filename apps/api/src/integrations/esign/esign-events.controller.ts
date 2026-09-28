import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequestId } from '@aramo/common';
import { ExecutedArtifactHashMismatchError } from '@aramo/documents';

import { EsignWriteBackOrchestrator } from '../../documents/esign-writeback.js';

import {
  ESIGN_WEBHOOK_SIGNATURE_HEADER,
  ESIGN_WEBHOOK_TIMESTAMP_HEADER,
  ESIGN_WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
} from './esign-webhook.constants.js';
import { verifyEsignWebhookSignature } from './esign-webhook-signature.js';

// E-Sign OC v2 — the CANONICAL E-Sign -> Core lifecycle-event receiver
// (Independent-Digital-Signature-Platform Directive sections 9, 11, 13B, 34).
//
// Consumer-owned integration code: Core authenticates the webhook (HMAC + a
// bounded timestamp window), then interprets the GENERIC event and drives the
// existing Documents write-back orchestration IN-PROCESS (never by calling the
// transitional /v1/documents/esign-writeback HTTP endpoint). It NEVER reaches into
// E-Sign persistence — it pulls authoritative executed artifacts through the
// existing provider/API seam inside EsignWriteBackOrchestrator, keyed by envelope_id.
//
// DELIBERATELY UN-GUARDED (like the platform's other signature-verified webhooks):
// the SOLE authority is the HMAC signature — there is no Aramo session. Outcomes:
//   503 — signing secret unset (dark by construction until provisioned)
//   401 — missing/stale/invalid signature (replay window enforced)
//   400 — malformed event payload
//   200 — ONLY after durable, idempotent acceptance (write-back persisted)
//   5xx — transient downstream failure -> E-Sign redelivers from its own outbox
//
// Delivery is at-least-once; duplicate events are harmless because the write-back
// is idempotent (per-envelope_document idempotency key), so the same event
// delivered twice yields the same final local result.
@Controller('v1/integrations/esign')
export class EsignEventsController {
  constructor(private readonly orchestrator: EsignWriteBackOrchestrator) {}

  @Post('events')
  async events(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @RequestId() requestId: string,
  ): Promise<{ received: boolean; event_id?: string; ignored?: boolean } | undefined> {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    const verdict = verifyEsignWebhookSignature({
      rawBody,
      timestampHeader: firstHeader(req.headers[ESIGN_WEBHOOK_TIMESTAMP_HEADER]),
      signatureHeader: firstHeader(req.headers[ESIGN_WEBHOOK_SIGNATURE_HEADER]),
      secret: process.env['ESIGN_WEBHOOK_SIGNING_SECRET'],
      nowSec: Math.floor(Date.now() / 1000),
      toleranceSec: ESIGN_WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
    });
    if (!verdict.ok) {
      res.status(verdict.reason === 'NO_SECRET' ? 503 : 401);
      return undefined;
    }

    let event: { event_id?: unknown; event_type?: unknown; tenant_id?: unknown; envelope_id?: unknown; correlation_id?: unknown };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400);
      return undefined;
    }
    if (
      typeof event.event_id !== 'string' ||
      typeof event.tenant_id !== 'string' ||
      typeof event.envelope_id !== 'string' ||
      typeof event.event_type !== 'string'
    ) {
      res.status(400);
      return undefined;
    }

    // Only completion facts drive write-back; other generic lifecycle facts are
    // acknowledged and ignored (a generic platform may emit created/sent/viewed/…).
    if (!isCompletionEvent(event.event_type)) {
      res.status(200);
      return { received: true, ignored: true, event_id: event.event_id };
    }

    try {
      await this.orchestrator.writeBackEnvelope({
        tenant_id: event.tenant_id,
        envelope_id: event.envelope_id,
        correlation_id: typeof event.correlation_id === 'string' ? event.correlation_id : undefined,
        requestId,
      });
      res.status(200);
      return { received: true, event_id: event.event_id };
    } catch (e) {
      // A genuine hash mismatch is a hard, non-retryable evidence failure.
      if (e instanceof ExecutedArtifactHashMismatchError) {
        res.status(422);
        return undefined;
      }
      // Everything else (esign pull / storage / transient) is retryable — E-Sign
      // owns redelivery from its durable outbox. Do NOT 200 an unaccepted event.
      res.status(502);
      return undefined;
    }
  }
}

function isCompletionEvent(eventType: string): boolean {
  return eventType.endsWith('envelope.executed.v1') || eventType.endsWith('envelope.completed.v1');
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
