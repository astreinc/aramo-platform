import { AramoError } from '@aramo/common';

// Domain-Enforcement P2b §2/§4 — DNS resolver env-var binding (fail-LOUD).
//
// Mirrors libs/mailer mailer.config.ts: a pure loader that reads process.env at
// call time and throws a 500 AramoError on misconfiguration — NEVER returns a
// silently-degraded config. A prod box accidentally left on the stub resolver
// (DNS_PROVIDER=stub) would "verify" nothing real; the fail-loud provider check
// + the stub's own loud warning make that scream rather than fake-succeed.
//
// Env-vars:
//   DNS_PROVIDER        — 'node' (prod: real DNS via Node's built-in dns) |
//                         'stub' (local/dev/test: canned records, no network).
//                         REQUIRED — no default, so an unset value fails loud
//                         rather than guessing (the box sets DNS_PROVIDER=node;
//                         vitest defaults it to 'stub').
//   DNS_RECORD_PREFIX   — the dedicated challenge subdomain label (§4). Default
//                         '_aramo-challenge'; the record name published is
//                         `${DNS_RECORD_PREFIX}.<allowed_domain>`.
//   DNS_VALUE_PREFIX    — the TXT value prefix (§4). Default
//                         'aramo-domain-verification='; the value published is
//                         `${DNS_VALUE_PREFIX}<token>`. Self-describing +
//                         filterable when multiple TXT values share the name.

export type DnsProvider = 'node' | 'stub';

export interface DnsConfig {
  readonly provider: DnsProvider;
  readonly recordPrefix: string;
  readonly valuePrefix: string;
}

const CONFIG_REQUEST_ID = 'dns-config';

export const DEFAULT_DNS_RECORD_PREFIX = '_aramo-challenge';
export const DEFAULT_DNS_VALUE_PREFIX = 'aramo-domain-verification=';

export function loadDnsConfig(): DnsConfig {
  const rawProvider = process.env['DNS_PROVIDER'];
  if (rawProvider === undefined || rawProvider.length === 0) {
    throw new AramoError(
      'INTERNAL_ERROR',
      'DNS_PROVIDER env-var is not set (expected "node" or "stub")',
      500,
      {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_missing', name: 'DNS_PROVIDER' },
      },
    );
  }
  if (rawProvider !== 'node' && rawProvider !== 'stub') {
    throw new AramoError(
      'INTERNAL_ERROR',
      `DNS_PROVIDER must be "node" or "stub" (got "${rawProvider}")`,
      500,
      {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_invalid', name: 'DNS_PROVIDER' },
      },
    );
  }
  const provider: DnsProvider = rawProvider;

  const rawRecordPrefix = process.env['DNS_RECORD_PREFIX'];
  const recordPrefix =
    rawRecordPrefix !== undefined && rawRecordPrefix.length > 0
      ? rawRecordPrefix
      : DEFAULT_DNS_RECORD_PREFIX;

  const rawValuePrefix = process.env['DNS_VALUE_PREFIX'];
  const valuePrefix =
    rawValuePrefix !== undefined && rawValuePrefix.length > 0
      ? rawValuePrefix
      : DEFAULT_DNS_VALUE_PREFIX;

  return { provider, recordPrefix, valuePrefix };
}
