import 'reflect-metadata';
import { parseArgs } from 'node:util';

import {
  IntelligencePrismaService,
  PrismaIntelligenceUnitOfWork,
  ServiceClientProvisioningError,
  provisionServiceClient,
} from '@aramo/intelligence-core';

// ATI-SEP-1 T4 — provision (create or rotate) a TI ServiceClient row.
// Invoked by tools/intelligence-service-client.sh (or directly):
//
//   node dist/apps/talent-intelligence-service/src/provision-service-client.js \
//     --client-id aramo-ats --source-system ARAMO_ATS \
//     --scopes intelligence:ingest,intelligence:read,intelligence:entitlements [--inactive]
//
// Secret: INTELLIGENCE_CLIENT_SECRET from the environment (>= 32 chars) — never
// an argument (it would land in shell history / ps). When absent, a random secret
// is generated and printed ONCE on stdout; only its scrypt hash is stored.
// Needs INTELLIGENCE_DATABASE_URL.

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'client-id': { type: 'string' },
      'source-system': { type: 'string', default: 'ARAMO_ATS' },
      scopes: { type: 'string' },
      inactive: { type: 'boolean', default: false },
    },
  });
  if (!values['client-id'] || !values.scopes) {
    process.stderr.write('usage: provision-service-client --client-id ID --scopes s1,s2 [--source-system ARAMO_ATS] [--inactive]\n');
    return 2;
  }
  const prisma = new IntelligencePrismaService();
  try {
    const secret = process.env['INTELLIGENCE_CLIENT_SECRET'];
    const result = await provisionServiceClient(new PrismaIntelligenceUnitOfWork(prisma), {
      client_id: values['client-id'],
      source_system_id: values['source-system'] ?? 'ARAMO_ATS',
      scopes: values.scopes.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
      ...(secret !== undefined && secret.length > 0 ? { secret } : {}),
      active: !values.inactive,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ServiceClientProvisioningError) {
      process.stderr.write(`provision-service-client: ${err.message}\n`);
      return 2;
    }
    throw err;
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`provision-service-client failed: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
