import { Injectable, Logger } from '@nestjs/common';
import {
  INTELLIGENCE_WEBHOOK_SIGNING_SECRET_ENV,
  INTELLIGENCE_WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
  isIntelligenceProfileUpdatedWebhook,
  verifyIntelligenceWebhook,
} from '@aramo/intelligence-contracts';
import { TalentIntelligenceRepository } from '@aramo/talent-record';

// ATI-SEP-1 T8 (ADR-0036 §3 "TI → ATS") — POST /v1/integrations/intelligence/events.
// No user session: the SOLE authority is the HMAC (aramo-intelligence-webhook-v1,
// INTELLIGENCE_WEBHOOK_SIGNING_SECRET, ±300 s). FAIL CLOSED: an unset secret, a
// missing / stale / bad signature → 401, before the body is even parsed.
//
// A verified delivery is RECORDED (inbox, keyed on event_id) and acknowledged
// 202; the worker's inbound sync does the TI read + policy apply off the request
// path. A replay of an already-recorded event_id → 200 { duplicate: true } and
// nothing else (idempotent). The inbox row is written before acknowledging, so an
// acknowledged delivery is never lost.

export interface WebhookReceiveInput {
  rawBody: Buffer;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  nowSec?: number;
  secret?: string | undefined;
}

export type WebhookReceiveResult =
  | { status: 401; body?: undefined }
  | { status: 400; body?: undefined }
  | { status: 202; body: { received: true; event_id: string } }
  | { status: 200; body: { received: true; duplicate: true; event_id: string } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class IntelligenceWebhookReceiver {
  private readonly logger = new Logger('IntelligenceWebhookReceiver');

  constructor(private readonly records: TalentIntelligenceRepository) {}

  async receive(input: WebhookReceiveInput): Promise<WebhookReceiveResult> {
    const rawBody = input.rawBody.toString('utf8');
    const verdict = verifyIntelligenceWebhook({
      rawBody,
      timestampHeader: input.timestampHeader,
      signatureHeader: input.signatureHeader,
      secret: input.secret ?? process.env[INTELLIGENCE_WEBHOOK_SIGNING_SECRET_ENV],
      nowSec: input.nowSec ?? Math.floor(Date.now() / 1000),
      toleranceSec: INTELLIGENCE_WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
    });
    if (!verdict.ok) {
      this.logger.warn({ event: 'intelligence_webhook_rejected', reason: verdict.reason });
      return { status: 401 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { status: 400 };
    }
    if (!isIntelligenceProfileUpdatedWebhook(parsed)) return { status: 400 };
    const occurred = new Date(parsed.occurred_at);
    if (
      !UUID.test(parsed.source_tenant_id) ||
      !UUID.test(parsed.external_talent_id) ||
      !UUID.test(parsed.intelligence_subject_id) ||
      parsed.event_id.length > 200 ||
      Number.isNaN(occurred.getTime())
    ) {
      return { status: 400 };
    }
    const outcome = await this.records.recordInboundEvent({
      event_id: parsed.event_id,
      tenant_id: parsed.source_tenant_id,
      talent_record_id: parsed.external_talent_id,
      intelligence_subject_id: parsed.intelligence_subject_id,
      changed_fact_types: parsed.changed_fact_types.slice(0, 50).map((c) => c.slice(0, 64)),
      occurred_at: occurred,
    });
    if (outcome === 'duplicate') {
      return { status: 200, body: { received: true, duplicate: true, event_id: parsed.event_id } };
    }
    return { status: 202, body: { received: true, event_id: parsed.event_id } };
  }
}
