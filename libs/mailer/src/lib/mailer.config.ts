import { AramoError } from '@aramo/common';

// Email-S1 §2.2 / §3 — mailer env-var binding (fail-LOUD).
//
// Mirrors libs/object-storage/object-storage.config.ts: a pure loader that
// reads process.env at call time and throws a 500 AramoError on any
// misconfiguration — NEVER returns a silently-degraded config. A
// mis-wired prod must fail loud (so invite email can't be silently
// dropped), never default to a no-op.
//
// Env-vars:
//   MAILER_PROVIDER   — 'ses' (prod: real SES send) | 'stub' (local/dev/
//                       test: log-only, no network). REQUIRED — no default,
//                       so an unset value fails loud rather than guessing.
//   SES_FROM_ADDRESS  — the fixed sender. REQUIRED when MAILER_PROVIDER=ses;
//                       the SES adapter pins every send to it and passes it
//                       VERBATIM to FromEmailAddress, so RFC-5322 display-name
//                       format is accepted ("Aramo Support <support@aramo.ai>").
//                       The IAM ses:FromAddress condition keys on the address
//                       part (support@aramo.ai) only.
//   AWS_REGION        — SES region (default 'us-east-1', matching the S3 /
//                       secret-cache precedent). Credentials follow the SDK
//                       default chain — never read here.

export type MailerProvider = 'ses' | 'stub';

export interface MailerConfig {
  readonly provider: MailerProvider;
  // Non-null only when provider === 'ses' (validated below); the stub
  // never sends from a real address.
  readonly fromAddress: string | null;
  readonly region: string;
}

const CONFIG_REQUEST_ID = 'mailer-config';

export function loadMailerConfig(): MailerConfig {
  const rawProvider = process.env['MAILER_PROVIDER'];
  if (rawProvider === undefined || rawProvider.length === 0) {
    throw new AramoError(
      'INTERNAL_ERROR',
      'MAILER_PROVIDER env-var is not set (expected "ses" or "stub")',
      500,
      {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_missing', name: 'MAILER_PROVIDER' },
      },
    );
  }
  if (rawProvider !== 'ses' && rawProvider !== 'stub') {
    throw new AramoError(
      'INTERNAL_ERROR',
      `MAILER_PROVIDER must be "ses" or "stub" (got "${rawProvider}")`,
      500,
      {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_invalid', name: 'MAILER_PROVIDER' },
      },
    );
  }
  const provider: MailerProvider = rawProvider;

  const region = process.env['AWS_REGION'] ?? 'us-east-1';

  const rawFrom = process.env['SES_FROM_ADDRESS'];
  const fromAddress =
    rawFrom !== undefined && rawFrom.length > 0 ? rawFrom : null;

  // SES mode REQUIRES a from-address — fail loud at config load (i.e. at
  // module binding) rather than discovering it on the first send attempt.
  if (provider === 'ses' && fromAddress === null) {
    throw new AramoError(
      'INTERNAL_ERROR',
      'SES_FROM_ADDRESS env-var is required when MAILER_PROVIDER=ses',
      500,
      {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_missing', name: 'SES_FROM_ADDRESS' },
      },
    );
  }

  return { provider, fromAddress, region };
}
