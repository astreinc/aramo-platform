import { PrismaService, SignIntegrationRepository, SignWebhookRepository } from '@aramo/esign';

import { digest, newClientId, newClientSecret } from './credentials.js';
import { encryptWebhookSecret, newWebhookSecret } from './webhook-secrets.js';

// Sign Unified Product S-4 — the OPERATOR CLI for the Sign application registry
// (no HTTP surface). Tenants manage their own installations and third-party
// credentials in the Sign workspace; what only an operator does lives here:
//
//   register-application  register a THIRD_PARTY application (inactive in
//                         production until public third-party activation — D-13)
//   first-party-credential issue an application-level credential for a
//                         FIRST_PARTY application (e.g. aramo-ats); the secret is
//                         printed ONCE and stored only as a digest
//   revoke-credential      revoke a credential by client id
//   first-party-webhook    an application-level webhook subscription for a
//                         FIRST_PARTY application (may target the private
//                         network); its signing secret is printed ONCE
//
// Usage (after build):
//   node dist/apps/esign-service/src/app/integrations/sign-integration.command.js first-party-credential aramo-ats
//   node …/sign-integration.command.js register-application <key> "<name>" <perm,perm,…> <USER|APPLICATION,…> [role,role,…]
//   node …/sign-integration.command.js revoke-credential <client_id>

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const prisma = new PrismaService();
  const repo = new SignIntegrationRepository(prisma);
  try {
    if (cmd === 'first-party-credential') {
      const key = args[0];
      if (key === undefined) return usage();
      const app = await repo.findApplicationByKey(key);
      if (app === null || app.kind !== 'FIRST_PARTY' || app.status !== 'ACTIVE') {
        console.error(`no ACTIVE FIRST_PARTY application "${key}"`);
        return 1;
      }
      const client_id = newClientId();
      const client_secret = newClientSecret();
      await repo.createCredential({ application_id: app.id, installation_id: null, client_id, secret_hash: digest(client_secret), created_by: null });
      console.log(`client_id=${client_id}`);
      console.log(`client_secret=${client_secret}`);
      console.error('Store the secret in the application’s secret configuration now — it is not stored and cannot be shown again.');
      return 0;
    }
    if (cmd === 'first-party-webhook') {
      const [key, url, events] = args;
      if (key === undefined || url === undefined) return usage();
      const app = await repo.findApplicationByKey(key);
      if (app === null || app.kind !== 'FIRST_PARTY' || app.status !== 'ACTIVE') {
        console.error(`no ACTIVE FIRST_PARTY application "${key}"`);
        return 1;
      }
      const secret = newWebhookSecret();
      const w = await new SignWebhookRepository(prisma).createSubscription({
        application_id: app.id,
        installation_id: null,
        tenant_id: null,
        target_url: url,
        event_types: (events ?? '').split(',').filter(Boolean),
        secret_ciphertext: encryptWebhookSecret(secret),
        internal: true,
        created_by: null,
      });
      console.log(`webhook_id=${w.id}`);
      console.log(`signing_secret=${secret}`);
      console.error('Store the signing secret in the receiving application’s configuration now — it cannot be shown again.');
      return 0;
    }
    if (cmd === 'register-application') {
      const [key, name, perms, modes, roles] = args;
      if (key === undefined || name === undefined || perms === undefined || modes === undefined) return usage();
      const app = await repo.createApplication({
        key,
        name,
        kind: 'THIRD_PARTY',
        requested_permissions: perms.split(',').filter(Boolean),
        modes: modes.split(',').filter(Boolean),
        assertable_roles: (roles ?? '').split(',').filter(Boolean),
      });
      console.log(`registered ${app.key} (${app.id})`);
      return 0;
    }
    if (cmd === 'revoke-credential') {
      const client_id = args[0];
      if (client_id === undefined) return usage();
      if (!(await repo.revokeCredentialByClientId(client_id))) {
        console.error('no such credential');
        return 1;
      }
      console.log(`revoked ${client_id}`);
      return 0;
    }
    return usage();
  } finally {
    await (prisma as unknown as { $disconnect(): Promise<void> }).$disconnect();
  }
}

function usage(): number {
  console.error('usage: sign-integration.command.js first-party-credential <app-key> | first-party-webhook <app-key> <url> [events] | register-application <key> <name> <perms> <modes> [roles] | revoke-credential <client_id>');
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}

export { main as signIntegrationCli };
