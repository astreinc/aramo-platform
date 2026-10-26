import { Inject, Injectable, Logger } from '@nestjs/common';
import { backoffMs, pushAllowedByPreferences, pushTextFor, SignNotificationRepository, type PushData, type PushJobRow, type SignNotificationType } from '@aramo/sign';

import { DEVICE_SESSION_LIVENESS, type DeviceSessionLiveness } from './device-session-liveness.js';
import { PUSH_DELIVERY_PORT, type PushDeliveryPort, type PushMessage, type PushProvider, type PushSendResult } from './push-delivery.port.js';
import { decryptPushToken } from './push-token-crypto.js';

// Aramo Sign Mobile — push delivery (M-A3 §2, §9; directive §8). Drains due push
// jobs through PUSH_DELIVERY_PORT:
//   - before anything else, and again UNDER A ROW LOCK just before the provider call
//     (correction 6), the device must be live: a job for a revoked device (or a
//     device whose native session ended) is dropped, never sent;
//   - preferences are re-read at send time (a type switched off is dropped; the
//     subject appears only if `lock_screen_subject` is on);
//   - transient failures retry with backoff up to MAX_PUSH_ATTEMPTS, then DEAD;
//   - a provider "unregistered" answer prunes the device (revoked, token deleted,
//     its queued jobs cancelled).
// Nothing here logs a provider token, a title or a body.

export const MAX_PUSH_ATTEMPTS = 5;
const SEND_TX_TIMEOUT_MS = 30_000;

export interface PushBatchResult {
  claimed: number;
  sent: number;
  cancelled: number;
  retried: number;
  failed: number;
  pruned: number;
}

@Injectable()
export class PushDeliveryService {
  private readonly log = new Logger('PushDelivery');

  constructor(
    private readonly repo: SignNotificationRepository,
    @Inject(PUSH_DELIVERY_PORT) private readonly push: PushDeliveryPort,
    @Inject(DEVICE_SESSION_LIVENESS) private readonly liveness: DeviceSessionLiveness,
  ) {}

  async deliverDueBatch(opts?: { now?: Date; limit?: number; leaseMs?: number }): Promise<PushBatchResult> {
    const result: PushBatchResult = { claimed: 0, sent: 0, cancelled: 0, retried: 0, failed: 0, pruned: 0 };
    if (this.push.providers.size === 0) return result;
    const now = opts?.now ?? new Date();
    const jobs = await this.repo.claimPushJobs(now, opts?.limit ?? 50, opts?.leaseMs ?? 60_000);
    result.claimed = jobs.length;
    for (const job of jobs) {
      try {
        await this.deliverOne(job, result);
      } catch (err) {
        const attempts = job.attempts + 1;
        const code = `error_${((err as Error).name ?? 'unknown').replace(/[^A-Za-z0-9_]/g, '_')}`;
        if (attempts >= MAX_PUSH_ATTEMPTS) {
          await this.repo.finishPushJob(job.id, 'DEAD', attempts, code);
          result.failed += 1;
        } else {
          await this.repo.retryPushJob(job.id, attempts, code, new Date(Date.now() + backoffMs(attempts)));
          result.retried += 1;
        }
      }
    }
    return result;
  }

  private async deliverOne(job: PushJobRow, result: PushBatchResult): Promise<void> {
    const cancel = async (code: string): Promise<void> => {
      await this.repo.finishPushJob(job.id, 'CANCELLED', job.attempts, code);
      result.cancelled += 1;
    };
    const device = await this.repo.findDevice(job.device_id);
    if (device === null || device.revoked_at !== null || device.push_token_ciphertext === null) return cancel('device_revoked');
    if (device.tenant_id !== job.tenant_id || device.user_id !== job.user_id) return cancel('owner_mismatch');
    if (!this.push.providers.has(device.provider as PushProvider)) return cancel('provider_off');
    const owner = { tenant_id: job.tenant_id, user_id: job.user_id };
    const session = await this.liveness.stateOf(device.device_session_id, owner);
    if (session === 'revoked') {
      await this.repo.revokeDevice(device.id, 'device_session_revoked');
      return cancel('device_session_revoked');
    }
    const n = await this.repo.getNotification(job.notification_id);
    if (n === null || n.tenant_id !== job.tenant_id || n.user_id !== job.user_id) return cancel('notification_gone');
    const type = n.type as SignNotificationType;
    const prefs = await this.repo.getPreferences(owner);
    if (!pushAllowedByPreferences(type, prefs)) return cancel('preference_off');
    const badge = await this.repo.unreadCount(owner);
    const data: PushData = n.audience === 'RECIPIENT' && n.inbox_item_id !== null ? { type, inbox_item_id: n.inbox_item_id } : { type, envelope_id: n.envelope_id };
    const message: PushMessage = { ...pushTextFor({ type, envelope_subject: n.envelope_subject, actor_name: n.actor_name }, prefs.lock_screen_subject), data, badge };

    // Correction 6 — re-check under the device row lock and send while holding it.
    const attempt = await this.repo.withLiveDeviceForSend(
      device.id,
      async (live): Promise<PushSendResult> => {
        let token: string;
        try {
          token = decryptPushToken(live.push_token_ciphertext);
        } catch {
          return { outcome: 'failed', error_code: 'token_unreadable' };
        }
        return this.push.send(live.provider as PushProvider, token, message);
      },
      SEND_TX_TIMEOUT_MS,
    );
    if (!attempt.ran) return cancel('device_revoked');
    const attempts = job.attempts + 1;
    const r = attempt.result;
    switch (r.outcome) {
      case 'sent':
        await this.repo.finishPushJob(job.id, 'SENT', attempts, null);
        result.sent += 1;
        return;
      case 'unregistered':
        await this.repo.finishPushJob(job.id, 'FAILED', attempts, r.error_code);
        await this.repo.revokeDevice(device.id, 'provider_unregistered');
        this.log.log(`push device ${device.id} pruned: the provider reported the token unregistered`);
        result.pruned += 1;
        result.failed += 1;
        return;
      case 'retry':
        if (attempts >= MAX_PUSH_ATTEMPTS) {
          await this.repo.finishPushJob(job.id, 'DEAD', attempts, r.error_code);
          result.failed += 1;
        } else {
          await this.repo.retryPushJob(job.id, attempts, r.error_code, new Date(Date.now() + backoffMs(attempts)));
          result.retried += 1;
        }
        return;
      case 'failed':
        await this.repo.finishPushJob(job.id, 'DEAD', attempts, r.error_code);
        result.failed += 1;
        return;
    }
  }
}
