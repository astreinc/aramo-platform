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
//   MAILER_PROVIDER=outbox — LOCAL DEVELOPMENT ONLY: every email is written as a
//                       JSON file into MAILER_OUTBOX_DIR (required) so local
//                       invitations and their links can be read and opened
//                       (tools/local-mail.cjs). No network. Refused outright when
//                       NODE_ENV=production (fail loud).
//   MAILER_OUTBOX_DELIVER_TO — optional, outbox mode only: comma-separated
//                       recipients that ALSO get a real SES email (needs
//                       SES_FROM_ADDRESS); all other addresses stay local.

export type MailerProvider = 'ses' | 'stub' | 'outbox';

export interface MailerConfig {
  readonly provider: MailerProvider;
  // Non-null only when provider === 'ses' (validated below); the stub
  // never sends from a real address.
  readonly fromAddress: string | null;
  readonly region: string;
  // Non-null only when provider === 'outbox' (local development).
  readonly outboxDir: string | null;
}

const CONFIG_REQUEST_ID = 'mailer-config';

export function loadMailerConfig(): MailerConfig {
  const rawProvider = process.env['MAILER_PROVIDER'];
  if (rawProvider === undefined || rawProvider.length === 0) {
    throw new AramoError(
      'INTERNAL_ERROR',
      'MAILER_PROVIDER env-var is not set (expected "ses", "stub" or "outbox")',
      500,
      {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_missing', name: 'MAILER_PROVIDER' },
      },
    );
  }
  if (rawProvider !== 'ses' && rawProvider !== 'stub' && rawProvider !== 'outbox') {
    throw new AramoError(
      'INTERNAL_ERROR',
      `MAILER_PROVIDER must be "ses", "stub" or "outbox" (got "${rawProvider}")`,
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
  const deliverReal = (process.env['MAILER_OUTBOX_DELIVER_TO'] ?? '').trim().length > 0;
  if ((provider === 'ses' || (provider === 'outbox' && deliverReal)) && fromAddress === null) {
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

  let outboxDir: string | null = null;
  if (provider === 'outbox') {
    if (process.env['NODE_ENV'] === 'production') {
      throw new AramoError('INTERNAL_ERROR', 'MAILER_PROVIDER=outbox is a local-development mailer and must not be used in production', 500, {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_invalid', name: 'MAILER_PROVIDER' },
      });
    }
    const dir = process.env['MAILER_OUTBOX_DIR'];
    if (dir === undefined || dir.length === 0) {
      throw new AramoError('INTERNAL_ERROR', 'MAILER_OUTBOX_DIR env-var is required when MAILER_PROVIDER=outbox', 500, {
        requestId: CONFIG_REQUEST_ID,
        details: { kind: 'env_missing', name: 'MAILER_OUTBOX_DIR' },
      });
    }
    outboxDir = dir;
  }

  return { provider, fromAddress, region, outboxDir };
}
