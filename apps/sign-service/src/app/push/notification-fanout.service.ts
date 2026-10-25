import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  backoffMs,
  pushAllowedByPreferences,
  SignNotificationRepository,
  type FanoutEnvelope,
  type NotificationDraft,
  type NotificationOwner,
  type OutboxRow,
  type SignNotificationType,
} from '@aramo/sign';
import { IdentityRepository } from '@aramo/identity';

import { PUSH_DELIVERY_PORT, type PushDeliveryPort } from './push-delivery.port.js';

// Aramo Sign Mobile — the notification fan-out (M-A3 §1, §2; directive §8). Drains
// the notification outbox (written in the ledger-event transaction) into feed rows
// and push jobs. Idempotent end to end:
//   - an outbox row is processed until processed_at is stamped (leased while in work);
//   - a feed row is unique per (user, dedupe_key), the key naming the source event
//     (a signer's first view is one key however often they open the link);
//   - a push job is unique per (device, notification), and only the outbox row that
//     created a feed row enqueues its pushes.
//
// Who hears what:
//   SENDER  (the envelope's owner, created_by, for Sign-console envelopes — the same
//            rule as the sender emails): SIGNED, VIEWED, DECLINED, COMPLETED, EXPIRED.
//   RECIPIENT (only a user who CLAIMED the recipient in their inbox, S-7 binding):
//            SIGNATURE_NEEDED (at send, or their turn in a sequential envelope) and
//            REMINDER. An unclaimed recipient gets nothing.
// Never: an event the user caused themselves (a sender signing, viewing or declining
// their own envelope; a sender reminding themselves), or routine create / attach /
// send events.

export const MAX_FANOUT_ATTEMPTS = 8;
// M-A3 §2 — per-user push rate limit: past this many push jobs in an hour, the feed
// row is still written but no further push is enqueued.
export const PUSH_PER_USER_PER_HOUR = 30;

const RECIPIENT_TYPES: ReadonlySet<string> = new Set(['SIGNATURE_NEEDED', 'REMINDER']);
const PENDING_SIGNER = new Set(['PENDING', 'VIEWED']);

export interface FanoutBatchResult {
  claimed: number;
  processed: number;
  failed: number;
  notifications: number;
  push_jobs: number;
}

@Injectable()
export class NotificationFanoutService {
  private readonly log = new Logger('NotificationFanout');

  constructor(
    private readonly repo: SignNotificationRepository,
    @Inject(PUSH_DELIVERY_PORT) private readonly push: PushDeliveryPort,
    @Optional() private readonly identity?: IdentityRepository,
  ) {}

  async processDueBatch(opts?: { now?: Date; limit?: number; leaseMs?: number }): Promise<FanoutBatchResult> {
    const now = opts?.now ?? new Date();
    const rows = await this.repo.claimOutbox(now, opts?.limit ?? 50, opts?.leaseMs ?? 60_000);
    const result: FanoutBatchResult = { claimed: rows.length, processed: 0, failed: 0, notifications: 0, push_jobs: 0 };
    for (const row of rows) {
      try {
        const r = await this.processRow(row, now);
        await this.repo.markOutboxProcessed(row.id);
        result.processed += 1;
        result.notifications += r.notifications;
        result.push_jobs += r.push_jobs;
      } catch (err) {
        const attempts = row.attempt_count + 1;
        const code = ((err as Error).name ?? 'error').replace(/[^A-Za-z0-9_]/g, '_');
        // Past the attempt cap the row is closed (processed_at stamped) with its error kept.
        await this.repo.markOutboxFailed(row.id, attempts, code, attempts >= MAX_FANOUT_ATTEMPTS ? null : new Date(Date.now() + backoffMs(attempts)));
        this.log.warn(`notification fan-out failed for outbox ${row.id} (attempt ${attempts}): ${code}`);
        result.failed += 1;
      }
    }
    return result;
  }

  // Public for tests: the drafts one outbox row produces.
  async draftsFor(row: OutboxRow): Promise<NotificationDraft[]> {
    const env = await this.repo.envelopeForFanout(row.tenant_id, row.envelope_id);
    if (env === null) return [];
    const type = row.kind as SignNotificationType;
    if (RECIPIENT_TYPES.has(type)) return this.recipientDrafts(row, env, type);
    return this.senderDrafts(row, env, type);
  }

  private async processRow(row: OutboxRow, now: Date): Promise<{ notifications: number; push_jobs: number }> {
    const drafts = await this.draftsFor(row);
    let notifications = 0;
    let pushJobs = 0;
    for (const d of drafts) {
      const n = await this.repo.upsertNotification(d);
      notifications += 1;
      // Only the outbox row that created the feed row pushes it (a repeat view, or a
      // redelivery of an earlier event, never pushes again).
      if (n.source_outbox_id !== row.id) continue;
      pushJobs += await this.enqueuePushes({ tenant_id: d.tenant_id, user_id: d.user_id }, n.id, d.type, now);
    }
    return { notifications, push_jobs: pushJobs };
  }

  private async enqueuePushes(owner: NotificationOwner, notification_id: string, type: SignNotificationType, now: Date): Promise<number> {
    if (this.push.providers.size === 0) return 0;
    const prefs = await this.repo.getPreferences(owner);
    if (!pushAllowedByPreferences(type, prefs)) return 0;
    const devices = await this.repo.listActiveDevices(owner, [...this.push.providers]);
    if (devices.length === 0) return 0;
    const recent = await this.repo.countPushJobsSince(owner, new Date(now.getTime() - 60 * 60 * 1000));
    if (recent >= PUSH_PER_USER_PER_HOUR) return 0;
    return this.repo.enqueuePushJobs(devices.map((d) => ({ ...owner, device_id: d.id, notification_id, payload_kind: type })));
  }

  // ── Sender side ──

  private isConsoleEnvelope(env: FanoutEnvelope): boolean {
    return env.origin_actor_kind === 'USER' && (env.has_owned_document || env.source_application === 'aramo-sign');
  }

  private async senderDrafts(row: OutboxRow, env: FanoutEnvelope, type: SignNotificationType): Promise<NotificationDraft[]> {
    if (!this.isConsoleEnvelope(env)) return [];
    const signer = row.signer_id === null ? undefined : env.signers.find((s) => s.id === row.signer_id);
    let actor: string | null = null;
    let dedupe = `${row.id}:${type}`;
    switch (type) {
      case 'SIGNED':
      case 'VIEWED':
      case 'DECLINED': {
        if (signer === undefined) return [];
        if (await this.signerIsSender(env, signer)) return []; // self-caused
        actor = signer.name;
        if (type === 'VIEWED') dedupe = `viewed:${env.id}:${signer.id}`;
        // The completion notice covers the signature that completed the envelope.
        if (type === 'SIGNED' && env.status === 'COMPLETED' && this.isLastSignature(env, signer.id)) return this.sequentialNext(row, env);
        break;
      }
      case 'COMPLETED':
      case 'EXPIRED':
        break;
      default:
        return [];
    }
    const drafts: NotificationDraft[] = [
      {
        tenant_id: env.tenant_id,
        user_id: env.created_by,
        type,
        audience: 'SENDER',
        envelope_id: env.id,
        inbox_item_id: null,
        envelope_subject: env.subject,
        actor_name: actor,
        dedupe_key: dedupe,
        source_outbox_id: row.id,
      },
    ];
    if (type === 'SIGNED') drafts.push(...(await this.sequentialNext(row, env)));
    return drafts;
  }

  private isLastSignature(env: FanoutEnvelope, signer_id: string): boolean {
    const signed = env.signers.filter((s) => s.signed_at !== null);
    if (signed.length !== env.signers.length) return false;
    const last = signed.reduce((a, b) => ((b.signed_at as Date).getTime() > (a.signed_at as Date).getTime() ? b : a));
    return last.id === signer_id;
  }

  private async signerIsSender(env: FanoutEnvelope, signer: FanoutEnvelope['signers'][number]): Promise<boolean> {
    const bindings = await this.repo.activeBindings(env.id, [signer.id]);
    if (bindings.some((b) => b.user_id === env.created_by)) return true;
    if (this.identity === undefined) return false;
    const sender = await this.identity.findUserById(env.created_by).catch(() => null);
    const email = sender?.email?.trim().toLowerCase();
    return email !== undefined && email !== '' && email === signer.email.trim().toLowerCase();
  }

  // ── Recipient side ──

  // SEQUENTIAL: the signer after the one who just signed now needs to sign.
  private async sequentialNext(row: OutboxRow, env: FanoutEnvelope): Promise<NotificationDraft[]> {
    if (env.routing_mode !== 'SEQUENTIAL' || row.signer_id === null) return [];
    if (env.status !== 'SENT' && env.status !== 'IN_PROGRESS') return [];
    const current = env.signers.find((s) => s.id === row.signer_id);
    if (current === undefined) return [];
    const next = env.signers.find((s) => s.signing_order > current.signing_order && PENDING_SIGNER.has(s.status));
    if (next === undefined) return [];
    return this.claimedDrafts(row, env, 'SIGNATURE_NEEDED', [next.id]);
  }

  private async recipientDrafts(row: OutboxRow, env: FanoutEnvelope, type: SignNotificationType): Promise<NotificationDraft[]> {
    if (env.status !== 'SENT' && env.status !== 'IN_PROGRESS') return [];
    let targets: string[];
    if (type === 'REMINDER' && row.signer_ids.length > 0) {
      targets = row.signer_ids;
    } else {
      // At send (and for a reminder that did not name its signers): every signer who
      // may sign now — all of them in PARALLEL, the first open one in SEQUENTIAL.
      const open = env.signers.filter((s) => PENDING_SIGNER.has(s.status));
      targets = (env.routing_mode === 'SEQUENTIAL' ? open.slice(0, 1) : open).map((s) => s.id);
    }
    return this.claimedDrafts(row, env, type, targets);
  }

  private async claimedDrafts(row: OutboxRow, env: FanoutEnvelope, type: SignNotificationType, signer_ids: string[]): Promise<NotificationDraft[]> {
    const bindings = await this.repo.activeBindings(env.id, signer_ids);
    if (bindings.length === 0) return [];
    const org = await this.senderOrganization(env.tenant_id);
    const out: NotificationDraft[] = [];
    for (const b of bindings) {
      if (b.user_id === env.created_by) continue; // the sender reminding / sending to themselves
      out.push({
        tenant_id: b.user_tenant_id,
        user_id: b.user_id,
        type,
        audience: 'RECIPIENT',
        envelope_id: env.id,
        inbox_item_id: b.id,
        envelope_subject: env.subject,
        actor_name: org,
        dedupe_key: `${row.id}:${type}:${b.signer_id}`,
        source_outbox_id: row.id,
      });
    }
    return out;
  }

  // The sender's organization display name — what the recipient inbox shows as "from".
  private async senderOrganization(tenant_id: string): Promise<string | null> {
    if (this.identity === undefined) return null;
    const t = await this.identity.findTenantNameById(tenant_id).catch(() => null);
    return t?.display_name ?? t?.name ?? null;
  }
}
