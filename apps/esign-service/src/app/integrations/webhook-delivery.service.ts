import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';

import { Injectable, Logger } from '@nestjs/common';
import { backoffMs, SignWebhookRepository, type SignWebhookSubscriptionRow } from '@aramo/esign';

import { computeEsignWebhookSignature } from '../webhook-event-publisher.js';

import { decryptWebhookSecret } from './webhook-secrets.js';
import { checkTargetShape, isPrivateAddress } from './webhook-target.js';

// Sign Unified Product S-5 — delivery of fanned-out lifecycle events, one row per
// (subscription, event), each with its own retry/backoff state. Every request is
// signed with the SUBSCRIPTION's own secret: HMAC-SHA256 over
// `${timestamp}.${rawBody}` (same scheme as before), and carries the event id and
// subscription id so a receiver can reject a replay (timestamp window) and drop a
// duplicate (event id). Tenant-configured targets are delivered over HTTPS with a
// connect-time address check (no DNS-rebinding window); operator-created
// first-party targets (`internal`) may use the private network.

const MAX_ATTEMPTS = 15;
const TIMEOUT_MS = 10_000;

type Sender = (url: string, headers: Record<string, string>, body: string, internal: boolean) => Promise<number>;

// Resolves through the system resolver, refusing any private / loopback /
// link-local address at CONNECT time.
function publicOnlyLookup(hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
    if (err !== null) return cb(err, '', 0);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      const e = new Error('private_address') as NodeJS.ErrnoException;
      e.code = 'EPRIVATEADDR';
      return cb(e, '', 0);
    }
    const all = (options as { all?: boolean }).all === true;
    return all ? cb(null, list) : cb(null, list[0]!.address, list[0]!.family);
  });
}

export const defaultSender: Sender = async (url, headers, body, internal) => {
  if (internal) {
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.status;
  }
  return new Promise<number>((resolve, reject) => {
    const req = httpsRequest(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() }, lookup: publicOnlyLookup as never, timeout: TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
};

export interface WebhookBatchResult {
  claimed: number;
  delivered: number;
  failed: number;
}

@Injectable()
export class SignWebhookDeliveryService {
  private readonly log = new Logger(SignWebhookDeliveryService.name);
  private sender: Sender = defaultSender;

  constructor(private readonly repo: SignWebhookRepository) {}

  // Test seam.
  useSender(sender: Sender): void {
    this.sender = sender;
  }

  async deliverOne(sub: SignWebhookSubscriptionRow, payload: unknown, event_id: string, now = new Date()): Promise<{ ok: true } | { ok: false; error_code: string }> {
    if (sub.status !== 'ACTIVE') return { ok: false, error_code: 'SUBSCRIPTION_DISABLED' };
    if (!sub.internal) {
      const shape = checkTargetShape(sub.target_url);
      if (shape !== null) return { ok: false, error_code: `TARGET_${shape.toUpperCase()}` };
    }
    let secret: string;
    try {
      secret = decryptWebhookSecret(sub.secret_ciphertext);
    } catch {
      return { ok: false, error_code: 'NO_SIGNING_SECRET' };
    }
    const rawBody = JSON.stringify(payload);
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const headers = {
      'content-type': 'application/json',
      'x-aramo-esign-timestamp': timestamp,
      'x-aramo-esign-signature': computeEsignWebhookSignature(timestamp, rawBody, secret),
      'x-aramo-esign-event-id': event_id,
      'x-aramo-esign-subscription-id': sub.id,
    };
    try {
      const status = await this.sender(sub.target_url, headers, rawBody, sub.internal);
      return status >= 200 && status < 300 ? { ok: true } : { ok: false, error_code: `HTTP_${status}` };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return { ok: false, error_code: code === 'EPRIVATEADDR' ? 'TARGET_PRIVATE_ADDRESS' : 'NETWORK' };
    }
  }

  async deliverDueBatch(opts?: { now?: Date; limit?: number; leaseMs?: number }): Promise<WebhookBatchResult> {
    const now = opts?.now ?? new Date();
    const due = await this.repo.claimDue(now, opts?.limit ?? 20, opts?.leaseMs ?? 60_000);
    let delivered = 0;
    let failed = 0;
    for (const row of due) {
      const r = await this.deliverOne(row.subscription, row.payload, row.event_id, now);
      if (r.ok) {
        await this.repo.markDelivered(row.id);
        delivered += 1;
      } else {
        const attempts = row.attempt_count + 1;
        const next = attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + backoffMs(attempts));
        await this.repo.markFailed(row.id, r.error_code, next);
        if (next === null) this.log.warn(`webhook delivery dead after ${attempts} attempts subscription=${row.subscription_id} event=${row.event_id} error=${r.error_code}`);
        failed += 1;
      }
    }
    return { claimed: due.length, delivered, failed };
  }
}
