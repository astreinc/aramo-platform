// Non-interactive e2e recruiter provisioning (Option B — Lead-approved).
//
// A new CALLER of the EXISTING invite saga — it changes ZERO runtime auth /
// identity / saga / verifier / scope code. It boots a Nest standalone context
// that imports IdentityModule and OVERRIDES the default StubTenantCognitoAdapter
// with the live TenantCognitoAdapter (the exact `useExisting` last-wins pattern
// apps/api uses), then calls TenantUserLifecycleService.inviteTenantUser — the
// real 2-leg saga (Cognito AdminCreateUser → DB tx, atomic with Cognito
// rollback). No raw SQL, no reimplementation.
//
// The financials-gate stub is left in place: it is consulted ONLY in
// assignTenantUserRoles, never in invite (verified), so an invite never calls it.
//
// RUN (local stack only; env loaded; symlinks from tools/local-run-link.sh so
// @aramo/* resolves to dist):
//   set -a && source .env && set +a
//   node --import jiti/register tools/provision-e2e-recruiter.ts \
//     --email recruiter-e2e@astreinc.test --tenant <TARGET_TENANT_ID> --role recruiter
//
// Requires (PO-supplied): TARGET_TENANT_ID, AWS admin creds capable of
// AdminCreateUser on the tenant pool. After it succeeds: set a PERMANENT
// password, handle MFA, seed visible assigned data, verify the login.

import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  IdentityModule,
  IdentityService,
  TenantUserLifecycleService,
  TENANT_COGNITO_PORT,
} from '@aramo/identity';

import { TenantCognitoAdapter } from '../apps/api/src/cognito/tenant-cognito.adapter.js';

import {
  assertNonProd,
  parseArgs,
  provisionRecruiter,
} from './provision-e2e-recruiter.lib.js';

// Compose above the freeze: import the real IdentityModule + re-bind the
// Cognito port to the live adapter (last-wins, exactly as apps/api does).
@Module({
  imports: [IdentityModule],
  providers: [
    TenantCognitoAdapter,
    { provide: TENANT_COGNITO_PORT, useExisting: TenantCognitoAdapter },
  ],
})
class ProvisioningModule {}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // SAFETY GUARD — abort unless this is a non-prod, local target.
  assertNonProd(process.env);

  const pool = process.env['AUTH_COGNITO_TENANT_USER_POOL_ID'] ?? '(unset)';
  console.log(
    `[provision] env=${process.env['ARAMO_ENV']} · local DB OK · tenant pool=${pool}`,
  );
  console.log(
    `[provision] email=${args.email} tenant=${args.tenant} role=${args.role}`,
  );

  const app = await NestFactory.createApplicationContext(ProvisioningModule, {
    logger: ['error', 'warn'],
  });
  try {
    const lifecycle = app.get(TenantUserLifecycleService);
    const identity = app.get(IdentityService);

    const result = await provisionRecruiter(
      { lifecycle, identity },
      {
        email: args.email,
        tenantId: args.tenant,
        role: args.role,
        actorUserId: args.actorUserId,
        requestId: randomUUID(),
      },
    );

    if (result.status === 'already_exists') {
      console.log(
        `[provision] ALREADY EXISTS — user_id=${result.user_id} tenant_id=${result.tenant_id}. No invite sent (idempotent).`,
      );
      return;
    }
    console.log('[provision] CREATED via the real invite saga:');
    console.log(`            cognito_sub = ${result.cognito_sub}`);
    console.log(`            user_id     = ${result.user_id}`);
    console.log(`            membership  = ${result.membership_id}`);
    console.log(`            tenant_id   = ${result.tenant_id}`);
    console.log(
      '[provision] NEXT (not done by this tool): set a PERMANENT password ' +
        '(admin-set-user-password --permanent), handle MFA, seed visible ' +
        'assigned data, then verify the login.',
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[provision] FAILED: ${message}`);
  process.exitCode = 1;
});
