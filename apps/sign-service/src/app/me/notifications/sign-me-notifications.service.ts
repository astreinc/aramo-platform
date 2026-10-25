import { Inject, Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import {
  PREFERENCE_FLAGS,
  SignNotificationRepository,
  type FeedCursor,
  type FeedRow,
  type NotificationOwner,
  type SignNotificationPreferences,
} from '@aramo/sign';

import { DEVICE_SESSION_LIVENESS, type DeviceSessionLiveness } from '../../push/device-session-liveness.js';
import { encryptPushToken, pushTokenDigest, pushTokenKeyAvailable } from '../../push/push-token-crypto.js';

// Aramo Sign Mobile — the signed-in user's notification feed, push device and push
// preferences (M-A3 §1, §2, §9). Web and mobile alike, except the device routes,
// which need a native session.
//
// OWNERSHIP: the owner is ALWAYS (auth.tenant_id, auth.sub) from the verified token.
// No route takes a user, tenant or device id that authorizes anything: a feed item
// id is looked up under the owner (another user's id answers 404), and the device
// is the token's own device session (`dsid`, M-A1 §3.6).
//
// Refusals (stable details.reason):
//   invalid_cursor                      400  the cursor is not one this API issued
//   invalid_limit                       400  limit is not an integer 1..100
//   invalid_notification_preferences    400  the body is not the six booleans
//   invalid_push_registration           400  platform / provider / push_token / app_version invalid
//   native_session_required             403  a device route without a native token (client + dsid)
//   session_revoked                     403  the token's device session has been revoked
//   push_registration_unavailable       503  SIGN_PUSH_TOKEN_KEY is not configured
//   (404 NOT_FOUND)                          a feed item that is not the caller's

export const FEED_DEFAULT_LIMIT = 20;
export const FEED_MAX_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APNS_TOKEN = /^[0-9a-fA-F]{32,200}$/;
const FCM_TOKEN = /^[A-Za-z0-9_:\-.]{20,4096}$/;
const APP_VERSION = /^[A-Za-z0-9.+\-_ ()]{1,64}$/;

export interface FeedItemView {
  id: string;
  type: string;
  // The sender's own envelope. Null on a recipient's item (the sender tenant's
  // envelope id is never disclosed to a recipient, Permission Contract §4.6).
  envelope_id: string | null;
  // A recipient's item: their inbox item (GET /v1/sign/inbox). Null on a sender's item.
  inbox_item_id: string | null;
  envelope_subject: string;
  actor_name: string | null;
  created_at: string;
  read_at: string | null;
}

// Native context claims (M-A1 §3.7). Read defensively: the shared AuthContext may
// not declare them in every build.
function nativeContext(auth: AuthContextType): { client: string | undefined; dsid: string | undefined } {
  const a = auth as AuthContextType & { client?: unknown; dsid?: unknown };
  return { client: typeof a.client === 'string' ? a.client : undefined, dsid: typeof a.dsid === 'string' ? a.dsid : undefined };
}

function ownerOf(auth: AuthContextType): NotificationOwner {
  return { tenant_id: auth.tenant_id, user_id: auth.sub };
}

function bad(reason: string, message: string, requestId: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason } });
}

export function encodeFeedCursor(row: { created_at: Date; id: string }): string {
  return Buffer.from(`${row.created_at.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeFeedCursor(raw: string): FeedCursor | null {
  if (raw.length > 200) return null;
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (iso === undefined || id === undefined || !UUID.test(id)) return null;
  const created_at = new Date(iso);
  return Number.isNaN(created_at.getTime()) ? null : { created_at, id };
}

function view(r: FeedRow): FeedItemView {
  const recipient = r.audience === 'RECIPIENT';
  return {
    id: r.id,
    type: r.type,
    envelope_id: recipient ? null : r.envelope_id,
    inbox_item_id: recipient ? r.inbox_item_id : null,
    envelope_subject: r.envelope_subject,
    actor_name: r.actor_name,
    created_at: r.created_at.toISOString(),
    read_at: r.read_at?.toISOString() ?? null,
  };
}

@Injectable()
export class SignMeNotificationsService {
  private readonly log = new Logger('SignMeNotifications');

  constructor(
    private readonly repo: SignNotificationRepository,
    @Inject(DEVICE_SESSION_LIVENESS) private readonly liveness: DeviceSessionLiveness,
  ) {}

  // ── Feed ──

  async list(auth: AuthContextType, query: { cursor?: unknown; limit?: unknown }, requestId: string): Promise<{ items: FeedItemView[]; next_cursor: string | null }> {
    let limit = FEED_DEFAULT_LIMIT;
    if (query.limit !== undefined && query.limit !== '') {
      const n = Number(query.limit);
      if (!Number.isInteger(n) || n < 1 || n > FEED_MAX_LIMIT) throw bad('invalid_limit', `limit must be an integer from 1 to ${FEED_MAX_LIMIT}`, requestId);
      limit = n;
    }
    let cursor: FeedCursor | null = null;
    if (query.cursor !== undefined && query.cursor !== '') {
      cursor = typeof query.cursor === 'string' ? decodeFeedCursor(query.cursor) : null;
      if (cursor === null) throw bad('invalid_cursor', 'The cursor is not valid', requestId);
    }
    const rows = await this.repo.listFeed(ownerOf(auth), { cursor, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(view), next_cursor: rows.length > limit && last !== undefined ? encodeFeedCursor(last) : null };
  }

  async unreadCount(auth: AuthContextType): Promise<{ count: number }> {
    return { count: await this.repo.unreadCount(ownerOf(auth)) };
  }

  async markRead(auth: AuthContextType, id: string, requestId: string): Promise<void> {
    if (!UUID.test(id) || !(await this.repo.markRead(ownerOf(auth), id))) {
      throw new AramoError('NOT_FOUND', 'Notification not found', 404, { requestId });
    }
  }

  async markAllRead(auth: AuthContextType): Promise<void> {
    await this.repo.markAllRead(ownerOf(auth));
  }

  // ── Preferences ──

  getPreferences(auth: AuthContextType): Promise<SignNotificationPreferences> {
    return this.repo.getPreferences(ownerOf(auth));
  }

  async putPreferences(auth: AuthContextType, body: unknown, requestId: string): Promise<SignNotificationPreferences> {
    const b = (body ?? {}) as Record<string, unknown>;
    const keys = [...PREFERENCE_FLAGS, 'lock_screen_subject'] as const;
    const extra = Object.keys(b).filter((k) => !(keys as readonly string[]).includes(k));
    if (extra.length > 0 || keys.some((k) => typeof b[k] !== 'boolean')) {
      throw bad('invalid_notification_preferences', 'Send signed, viewed, declined, signature_needed, reminders and lock_screen_subject, each true or false', requestId);
    }
    const prefs: SignNotificationPreferences = {
      signed: b['signed'] as boolean,
      viewed: b['viewed'] as boolean,
      declined: b['declined'] as boolean,
      signature_needed: b['signature_needed'] as boolean,
      reminders: b['reminders'] as boolean,
      lock_screen_subject: b['lock_screen_subject'] as boolean,
    };
    return this.repo.putPreferences(ownerOf(auth), prefs);
  }

  // ── Device (the token's own native device session) ──

  private async currentSession(auth: AuthContextType, requestId: string): Promise<string> {
    const { client, dsid } = nativeContext(auth);
    if (client !== 'native' || dsid === undefined || !UUID.test(dsid)) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Push registration needs the Aramo Sign app', 403, { requestId, details: { reason: 'native_session_required' } });
    }
    return dsid;
  }

  async registerDevice(auth: AuthContextType, body: unknown, requestId: string): Promise<void> {
    const dsid = await this.currentSession(auth, requestId);
    const b = (body ?? {}) as Record<string, unknown>;
    const platform = b['platform'];
    const provider = b['provider'];
    const token = b['push_token'];
    const appVersion = b['app_version'];
    const valid =
      (platform === 'ios' || platform === 'android') &&
      (provider === 'apns' || provider === 'fcm') &&
      typeof token === 'string' &&
      (provider === 'apns' ? APNS_TOKEN.test(token) : FCM_TOKEN.test(token)) &&
      typeof appVersion === 'string' &&
      APP_VERSION.test(appVersion);
    if (!valid) throw bad('invalid_push_registration', 'Send platform (ios|android), provider (apns|fcm), a valid push_token and app_version', requestId);
    if (!pushTokenKeyAvailable()) {
      throw new AramoError('ESIGN_SEND_UNAVAILABLE', 'Push notifications are not available', 503, { requestId, details: { reason: 'push_registration_unavailable' } });
    }
    const owner = ownerOf(auth);
    if ((await this.liveness.stateOf(dsid, owner)) === 'revoked') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'This device has been signed out', 403, { requestId, details: { reason: 'session_revoked' } });
    }
    const r = await this.repo.upsertDevice({
      owner,
      device_session_id: dsid,
      platform: platform as 'ios' | 'android',
      provider: provider as 'apns' | 'fcm',
      push_token_ciphertext: encryptPushToken(token as string),
      push_token_digest: pushTokenDigest(provider as string, token as string),
      app_version: appVersion as string,
    });
    if (r.outcome === 'not_owner') {
      // A dsid is minted for one user and tenant; reaching here means the session is not this caller's.
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'This device has been signed out', 403, { requestId, details: { reason: 'session_revoked' } });
    }
    this.log.log(`push device registered device=${r.id} provider=${provider as string} request=${requestId}`);
  }

  async removeDevice(auth: AuthContextType, requestId: string): Promise<void> {
    const dsid = await this.currentSession(auth, requestId);
    const r = await this.repo.revokeDeviceBySession(ownerOf(auth), dsid, 'user_removed');
    if (r.revoked) this.log.log(`push device removed jobs_cancelled=${r.jobs_cancelled} request=${requestId}`);
  }
}
