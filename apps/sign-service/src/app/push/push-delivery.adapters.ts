import { Logger } from '@nestjs/common';

import { ApnsPushAdapter, apnsConfigFromEnv } from './apns-push.adapter.js';
import { FcmPushAdapter, fcmConfigFromEnv } from './fcm-push.adapter.js';
import type { PushDeliveryPort, PushMessage, PushProvider, PushSendResult } from './push-delivery.port.js';

// Aramo Sign Mobile — PUSH_DELIVERY_PORT bindings. SIGN_PUSH_DELIVERY:
//   unset | disabled   no push (the default): no push job is enqueued
//   log                every push is logged (type and provider only), nothing is sent
//   apns | fcm | apns,fcm   the real providers; a provider whose configuration is
//                           missing or unreadable is left out (logged), never fatal

const log = new Logger('PushDelivery');

export class DisabledPushDelivery implements PushDeliveryPort {
  readonly providers: ReadonlySet<PushProvider> = new Set();
  async send(): Promise<PushSendResult> {
    return { outcome: 'failed', error_code: 'push_disabled' };
  }
}

// Local / staging: proves the pipeline without a provider. Never logs the token,
// the text or the data ids.
export class LogPushDelivery implements PushDeliveryPort {
  readonly providers: ReadonlySet<PushProvider> = new Set(['apns', 'fcm']);
  readonly sent: Array<{ provider: PushProvider; type: string }> = [];
  async send(provider: PushProvider, _token: string, message: PushMessage): Promise<PushSendResult> {
    this.sent.push({ provider, type: message.data.type });
    log.log(`push (log) provider=${provider} type=${message.data.type}`);
    return { outcome: 'sent' };
  }
}

interface ProviderAdapter {
  send(token: string, message: PushMessage): Promise<PushSendResult>;
}

export class ProviderPushDelivery implements PushDeliveryPort {
  readonly providers: ReadonlySet<PushProvider>;
  constructor(private readonly adapters: Partial<Record<PushProvider, ProviderAdapter>>) {
    this.providers = new Set(Object.keys(adapters) as PushProvider[]);
  }
  async send(provider: PushProvider, token: string, message: PushMessage): Promise<PushSendResult> {
    const a = this.adapters[provider];
    if (a === undefined) return { outcome: 'failed', error_code: 'provider_not_configured' };
    return a.send(token, message);
  }
}

export function pushDeliveryFromEnv(env: NodeJS.ProcessEnv = process.env): PushDeliveryPort {
  const mode = (env['SIGN_PUSH_DELIVERY'] ?? 'disabled').trim().toLowerCase();
  if (mode === '' || mode === 'disabled') return new DisabledPushDelivery();
  if (mode === 'log') return new LogPushDelivery();
  const wanted = new Set(mode.split(',').map((s) => s.trim()).filter((s) => s !== ''));
  const adapters: Partial<Record<PushProvider, ProviderAdapter>> = {};
  if (wanted.has('apns')) {
    try {
      const cfg = apnsConfigFromEnv(env);
      if (cfg === null) log.error('SIGN_PUSH_DELIVERY includes apns but APNS_KEY_ID / APNS_TEAM_ID / APNS_KEY_PATH / APNS_TOPIC are not all set; APNs is off');
      else adapters.apns = new ApnsPushAdapter(cfg);
    } catch (err) {
      log.error(`APNs is off: the key could not be loaded (${(err as Error).name})`);
    }
  }
  if (wanted.has('fcm')) {
    try {
      const cfg = fcmConfigFromEnv(env);
      if (cfg === null) log.error('SIGN_PUSH_DELIVERY includes fcm but FCM_PROJECT_ID / FCM_SERVICE_ACCOUNT_PATH are not both set; FCM is off');
      else adapters.fcm = new FcmPushAdapter(cfg);
    } catch (err) {
      log.error(`FCM is off: the service account could not be loaded (${(err as Error).name})`);
    }
  }
  for (const w of wanted) if (w !== 'apns' && w !== 'fcm') log.error(`SIGN_PUSH_DELIVERY: unknown provider "${w}" ignored`);
  return Object.keys(adapters).length === 0 ? new DisabledPushDelivery() : new ProviderPushDelivery(adapters);
}
