// DB-ONLY link of the e2e recruiter's real Cognito sub to the pre-seeded
// backend user (PATH-SEED). NO Cognito, NO AWS, NO provisioning, NO push.
//
// Precondition: recruiter@aramo.dev already exists as identity.User
// e9c67ca8-1fc9-4fdd-8a00-e7e6e6367c8f (tools/enable-e2e-recruiter.ts) and the
// PO has created + Confirmed the Cognito user (email_verified). This tool only
// attaches the (provider='cognito', provider_subject=<real sub>) link via the
// REAL IdentityRepository.linkExternalIdentity (idempotent upsert on the
// [provider, provider_subject] unique key) — NOT a raw INSERT. Admin's rows are
// untouched. Seeds ONLY the real-sub row (no fixed-dev placeholder).
//
// RUN (local stack only; env loaded; dist built):
//   set -a && source .env && set +a
//   node --import jiti/register tools/link-e2e-recruiter-sub.ts --sub <recruiter-cognito-sub>

import { NestFactory } from '@nestjs/core';
import { IdentityRepository, PrismaService } from '@aramo/identity';

import { AppModule } from '../dist/apps/api/src/app.module.js';

import { assertNonProd } from './seed-e2e-data.lib.js';

const RECRUITER_USER_ID = 'e9c67ca8-1fc9-4fdd-8a00-e7e6e6367c8f';
const RECRUITER_EMAIL = 'recruiter@aramo.dev';
const ADMIN_USER_ID = '01900000-0000-7000-8000-000000000002';
const PROVIDER = 'cognito';

// A real Cognito sub is a 36-char UUID. Refuse anything else (esp. the
// `fixed-dev-...` placeholder shape) so we never seed a fake link.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseSub(argv: readonly string[]): string {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t !== undefined && t.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(t.slice(2), next);
        i += 1;
      } else flags.set(t.slice(2), 'true');
    }
  }
  const sub = (flags.get('sub') ?? '').trim();
  if (sub === '') {
    throw new Error('--sub <recruiter-cognito-sub> is required (PO-supplied).');
  }
  if (!UUID_RE.test(sub)) {
    throw new Error(
      `--sub '${sub}' is not a 36-char UUID — refusing (must match admin's real-sub shape, not a placeholder).`,
    );
  }
  return sub;
}

async function main(): Promise<void> {
  const sub = parseSub(process.argv.slice(2));
  assertNonProd(process.env);
  console.log(
    `[link] env=${process.env['ARAMO_ENV']} · local DB OK · user=${RECRUITER_USER_ID} sub=${sub}`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const repo = app.get(IdentityRepository);
    const prisma = app.get(PrismaService);

    const row = await repo.linkExternalIdentity({
      provider: PROVIDER,
      provider_subject: sub,
      user_id: RECRUITER_USER_ID,
      email_snapshot: RECRUITER_EMAIL,
    });

    // Confirm admin's two rows are intact (untouched, additive write).
    const adminRows = await prisma.externalIdentity.findMany({
      where: { user_id: ADMIN_USER_ID },
      select: { provider_subject: true },
      orderBy: { created_at: 'asc' },
    });

    console.log('\n[link] DONE — ExternalIdentity linked (real-sub only):');
    console.log(`        id               = ${row.id}`);
    console.log(`        provider         = ${row.provider}`);
    console.log(`        provider_subject = ${row.provider_subject}`);
    console.log(`        user_id          = ${row.user_id}`);
    console.log(`        email_snapshot   = ${row.email_snapshot}`);
    console.log(
      `        admin rows intact = ${adminRows.length} (${adminRows
        .map((r) => r.provider_subject)
        .join(', ')})`,
    );
    console.log(
      '\n[link] recruiter@aramo.dev hosted-UI login should now resolve-by-sub → recruiter user → recruiter scopes.',
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[link] FAILED: ${message}`);
  process.exitCode = 1;
});
