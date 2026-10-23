import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EVENT_VERSION,
  GOLDEN_TALENT_PROFILE_UPDATED,
  IDENTIFIER_VERIFICATION_REQUESTED,
  INTELLIGENCE_ATS_WEBHOOK_URL_ENV,
  INTELLIGENCE_WEBHOOK_SIGNING_SECRET_ENV,
  signIntelligenceWebhook,
  type IntelligenceProfileUpdatedWebhook,
  type SourceSystemId,
} from '@aramo/intelligence-contracts';

import { survivingSubject } from '../identity/identity-resolution.service.js';
import {
  INTELLIGENCE_UNIT_OF_WORK,
  type IntelligenceOutbox,
  type IntelligenceUnitOfWork,
  type IntelligenceWebhookDelivery,
  type NewWebhookDelivery,
} from '../repositories/types.js';
import { VERIFICATION_CODE_SERVICE, type VerificationCodeService } from '../verification/verification-code.js';
import { VERIFICATION_DELIVERY_PORT, type VerificationDeliveryPort } from '../verification/verification-delivery.js';

// ATI-SEP-1 T7 (ADR-0036 §3 "TI → ATS") — the lease-safe outbox drain.
//
// Phase 1 — IntelligenceOutbox rows (claim = FOR UPDATE SKIP LOCKED + lease):
//   'golden_talent.profile_updated'      → FAN-OUT, in one transaction, into one
//       IntelligenceWebhookDelivery per ACTIVE reference of an ENTITLED tenant,
//       then the outbox row is published. (A subject with no such reference
//       publishes with zero deliveries.)
//   'identifier_verification.requested' → the verification DELIVERY PORT (never
//       the webhook). SENT → published, NOT_AVAILABLE → quarantined (SMS on
//       hold), RETRY → backoff, quarantined after the attempt cap. A request no
//       longer PENDING (or expired) publishes without sending.
//   anything else → quarantined (UNKNOWN_EVENT_TYPE).
// Phase 2 — deliveries: POST the HMAC-signed body (webhook-auth in
//   intelligence-contracts) to INTELLIGENCE_ATS_WEBHOOK_URL. 2xx → delivered;
//   otherwise exponential backoff, quarantined after the attempt cap.
//   At-least-once: the receiver dedupes on event_id (= the delivery id).
//   Fail closed: with no signing secret or URL nothing is sent and the row is
//   left to its lease (it retries without consuming attempts).
// Every write after the network call is guarded by the claim token
// (claimed_at): a worker that lost its lease writes nothing.

export const WEBHOOK_TRANSPORT = Symbol('WEBHOOK_TRANSPORT');

export interface WebhookTransport {
  post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number }>;
}

export const WEBHOOK_TRANSPORT_TIMEOUT_MS = 10_000;

/** Default transport: fetch with a timeout. */
export class FetchWebhookTransport implements WebhookTransport {
  async post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TRANSPORT_TIMEOUT_MS),
    });
    return { status: res.status };
  }
}

export interface DrainConfig {
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  webhookUrl: string | null;
  signingSecret: string | null;
}

export const INTELLIGENCE_OUTBOX_MAX_ATTEMPTS_ENV = 'INTELLIGENCE_OUTBOX_MAX_ATTEMPTS';

export function drainConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DrainConfig {
  const max = Number(env[INTELLIGENCE_OUTBOX_MAX_ATTEMPTS_ENV]);
  const url = env[INTELLIGENCE_ATS_WEBHOOK_URL_ENV]?.trim() ?? '';
  const secret = env[INTELLIGENCE_WEBHOOK_SIGNING_SECRET_ENV] ?? '';
  return {
    batchSize: 25,
    leaseMs: 60_000,
    maxAttempts: Number.isInteger(max) && max > 0 ? max : 10,
    baseBackoffMs: 5_000,
    maxBackoffMs: 3_600_000,
    webhookUrl: url.length > 0 ? url : null,
    signingSecret: secret.length > 0 ? secret : null,
  };
}

/** Exponential backoff after `attempts` failures (1-based). */
export function backoffMs(attempts: number, cfg: Pick<DrainConfig, 'baseBackoffMs' | 'maxBackoffMs'>): number {
  return Math.min(cfg.maxBackoffMs, cfg.baseBackoffMs * 2 ** Math.max(0, attempts - 1));
}

export interface DrainReport {
  outbox_published: number;
  outbox_retried: number;
  outbox_quarantined: number;
  deliveries_created: number;
  deliveries_delivered: number;
  deliveries_retried: number;
  deliveries_quarantined: number;
  deliveries_deferred: number;
}

class LeaseLostError extends Error {}

const emptyReport = (): DrainReport => ({
  outbox_published: 0,
  outbox_retried: 0,
  outbox_quarantined: 0,
  deliveries_created: 0,
  deliveries_delivered: 0,
  deliveries_retried: 0,
  deliveries_quarantined: 0,
  deliveries_deferred: 0,
});

@Injectable()
export class IntelligenceOutboxDrainService {
  private readonly logger = new Logger('IntelligenceOutboxDrain');

  constructor(
    @Inject(INTELLIGENCE_UNIT_OF_WORK) private readonly uow: IntelligenceUnitOfWork,
    @Inject(VERIFICATION_DELIVERY_PORT) private readonly delivery: VerificationDeliveryPort,
    @Inject(VERIFICATION_CODE_SERVICE) private readonly codes: VerificationCodeService,
    @Inject(WEBHOOK_TRANSPORT) private readonly transport: WebhookTransport,
  ) {}

  async drainOnce(now: Date = new Date(), cfg: DrainConfig = drainConfigFromEnv()): Promise<DrainReport> {
    const report = emptyReport();
    const rows = await this.uow.run((repos) => repos.outbox.claim(cfg.batchSize, now, cfg.leaseMs));
    for (const row of rows) {
      try {
        await this.processOutbox(row, now, cfg, report);
      } catch (err) {
        if (!(err instanceof LeaseLostError)) this.logger.warn(`outbox ${row.id} failed: ${(err as Error).message}`);
      }
    }
    const deliveries = await this.uow.run((repos) => repos.deliveries.claim(cfg.batchSize, now, cfg.leaseMs));
    for (const d of deliveries) {
      try {
        await this.processDelivery(d, now, cfg, report);
      } catch (err) {
        this.logger.warn(`delivery ${d.id} failed: ${(err as Error).message}`);
      }
    }
    return report;
  }

  private async processOutbox(row: IntelligenceOutbox, now: Date, cfg: DrainConfig, report: DrainReport): Promise<void> {
    const claimedAt = row.claimed_at as Date;
    if (row.event_type === GOLDEN_TALENT_PROFILE_UPDATED) {
      report.deliveries_created += await this.uow.run(async (repos) => {
        const subject = await survivingSubject(repos, row.subject_id);
        const payload = (row.payload ?? {}) as { changed_fact_types?: unknown };
        const changed = Array.isArray(payload.changed_fact_types) ? payload.changed_fact_types.filter((c): c is string => typeof c === 'string') : [];
        const rows: NewWebhookDelivery[] = [];
        for (const ref of await repos.references.listBySubject(subject.id)) {
          if (ref.status !== 'ACTIVE') continue;
          const ent = await repos.entitlements.find(ref.source_system_id, ref.source_tenant_id);
          if (ent === null || !ent.active) continue;
          rows.push({
            outbox_event_id: row.id,
            reference_id: ref.id,
            subject_id: subject.id,
            source_system_id: ref.source_system_id,
            source_tenant_id: ref.source_tenant_id,
            external_talent_id: ref.external_talent_id,
            payload: { intelligence_subject_id: subject.id, occurred_at: row.occurred_at.toISOString(), changed_fact_types: changed },
          });
        }
        const created = await repos.deliveries.createMany(rows);
        if (!(await repos.outbox.markPublished(row.id, claimedAt, now))) throw new LeaseLostError();
        return created;
      });
      report.outbox_published++;
      return;
    }

    if (row.event_type === IDENTIFIER_VERIFICATION_REQUESTED) {
      const payload = (row.payload ?? {}) as { verification_id?: string };
      const req = payload.verification_id ? await this.uow.run((repos) => repos.verifications.findById(payload.verification_id as string)) : null;
      if (req === null || req.status !== 'PENDING' || req.expires_at.getTime() <= now.getTime()) {
        await this.uow.run((repos) => repos.outbox.markPublished(row.id, claimedAt, now));
        report.outbox_published++;
        return;
      }
      const result = await this.delivery.deliver({
        verification_id: req.id,
        channel: req.channel as 'EMAIL' | 'SMS',
        destination: req.normalized_value,
        code: this.codes.codeFor(req.id, req.code_salt),
        expires_at: req.expires_at,
      });
      if (result.status === 'SENT') {
        await this.uow.run((repos) => repos.outbox.markPublished(row.id, claimedAt, now));
        report.outbox_published++;
      } else if (result.status === 'NOT_AVAILABLE') {
        await this.uow.run((repos) => repos.outbox.quarantine(row.id, claimedAt, 'NOT_AVAILABLE', now));
        report.outbox_quarantined++;
      } else {
        await this.retryOrQuarantineOutbox(row, claimedAt, result.error, now, cfg, report);
      }
      return;
    }

    await this.uow.run((repos) => repos.outbox.quarantine(row.id, claimedAt, 'UNKNOWN_EVENT_TYPE', now));
    report.outbox_quarantined++;
  }

  private async retryOrQuarantineOutbox(
    row: IntelligenceOutbox,
    claimedAt: Date,
    error: string,
    now: Date,
    cfg: DrainConfig,
    report: DrainReport,
  ): Promise<void> {
    const attempts = row.publish_attempts + 1;
    if (attempts >= cfg.maxAttempts) {
      await this.uow.run((repos) => repos.outbox.quarantine(row.id, claimedAt, error, now));
      report.outbox_quarantined++;
    } else {
      await this.uow.run((repos) => repos.outbox.markRetry(row.id, claimedAt, error, new Date(now.getTime() + backoffMs(attempts, cfg))));
      report.outbox_retried++;
    }
  }

  /** The exact webhook body of one delivery. */
  static webhookBody(d: IntelligenceWebhookDelivery): IntelligenceProfileUpdatedWebhook {
    const p = (d.payload ?? {}) as { intelligence_subject_id?: string; occurred_at?: string; changed_fact_types?: string[] };
    return {
      event_id: d.id,
      event_type: GOLDEN_TALENT_PROFILE_UPDATED,
      event_version: EVENT_VERSION,
      intelligence_subject_id: p.intelligence_subject_id ?? d.subject_id,
      occurred_at: p.occurred_at ?? d.created_at.toISOString(),
      source_system_id: d.source_system_id as SourceSystemId,
      source_tenant_id: d.source_tenant_id,
      external_talent_id: d.external_talent_id,
      changed_fact_types: p.changed_fact_types ?? [],
    };
  }

  private async processDelivery(d: IntelligenceWebhookDelivery, now: Date, cfg: DrainConfig, report: DrainReport): Promise<void> {
    const claimedAt = d.claimed_at as Date;
    if (cfg.webhookUrl === null || cfg.signingSecret === null) {
      // Never deliver unsigned or nowhere: leave the row to its lease.
      report.deliveries_deferred++;
      return;
    }
    const rawBody = JSON.stringify(IntelligenceOutboxDrainService.webhookBody(d));
    const headers = signIntelligenceWebhook({ rawBody, secret: cfg.signingSecret, nowSec: Math.floor(now.getTime() / 1000) });
    let error: string;
    try {
      const res = await this.transport.post(cfg.webhookUrl, headers, rawBody);
      if (res.status >= 200 && res.status < 300) {
        await this.uow.run((repos) => repos.deliveries.markDelivered(d.id, claimedAt, now));
        report.deliveries_delivered++;
        return;
      }
      error = `HTTP_${res.status}`;
    } catch (err) {
      error = (err as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
    }
    const attempts = d.attempts + 1;
    if (attempts >= cfg.maxAttempts) {
      await this.uow.run((repos) => repos.deliveries.quarantine(d.id, claimedAt, error, now));
      report.deliveries_quarantined++;
    } else {
      await this.uow.run((repos) => repos.deliveries.markRetry(d.id, claimedAt, error, new Date(now.getTime() + backoffMs(attempts, cfg))));
      report.deliveries_retried++;
    }
  }
}
