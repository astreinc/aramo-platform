import { Logger } from '@nestjs/common';
import { DisabledEstampAdapter, type EstampPort } from '@aramo/sign';

// Feature-Parity §1.19 under Amendment A1 — no e-stamp aggregator is selected (§5 D-3),
// so the only adapter is `disabled`. A vendor adapter (an aggregator or a state portal)
// is added here once the PO contracts one; it is never hardcoded before that.
export function estampAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): EstampPort {
  const v = env['SIGN_ESTAMP_PROVIDER']?.trim();
  if (v !== undefined && v !== '' && v.toLowerCase() !== 'disabled') {
    new Logger('Estamp').warn(`SIGN_ESTAMP_PROVIDER=${v.slice(0, 32)} has no adapter; India e-stamp stays disabled`);
  }
  return new DisabledEstampAdapter();
}
