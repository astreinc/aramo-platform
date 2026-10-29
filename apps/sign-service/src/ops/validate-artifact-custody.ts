// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 item 8 —
// READ-ONLY recovery validation of Sign artifact custody. For the given tenant (and
// optionally envelopes) it reads the ExecutedDocument / ExecutionCertificate rows and the
// custody ledger events in a READ ONLY transaction, fetches every artifact (executed PDFs,
// certificate, evidence snapshot) from the Sign bucket BY VERSION ID and verifies its
// SHA-256 against the row and the ledger. It writes nothing to the database or S3.
// Exit 0 = every artifact OK; 1 = any MISSING_CUSTODY / mismatch / fetch failure; 2 = fatal.
//
// The delete-version / retention-bypass refusal checks of SX-2 item 8 are NOT performed
// here (they need write-shaped calls against the bucket policy; separate checkpoint).
//
// Usage (env: DATABASE_URL + the SIGN_ARTIFACT_* settings of the principal to test):
//   npm run sign:validate-artifact-custody -- --tenant <uuid> [--envelope <uuid> ...]
// In the sign-service image:
//   node dist/apps/sign-service/src/ops/validate-artifact-custody.js --tenant <uuid>
import { EsignRepository, PrismaService, SignArtifactCustodyRepository } from '@aramo/sign';

import { buildCustodyRefs, validateArtifactCustody } from '../app/custody/artifact-custody-validation.js';
import { SignArtifactStore } from '../app/custody/sign-artifact-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]): { tenant_id: string; envelope_ids: string[] } {
  let tenant_id: string | undefined;
  const envelope_ids: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--tenant' && v !== undefined) { tenant_id = v; i += 1; }
    else if (a === '--envelope' && v !== undefined) { envelope_ids.push(v); i += 1; }
  }
  if (tenant_id === undefined || !UUID.test(tenant_id)) throw new Error('--tenant <uuid> is required');
  for (const e of envelope_ids) if (!UUID.test(e)) throw new Error(`--envelope must be a UUID (got "${e}")`);
  return { tenant_id, envelope_ids };
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('[artifact-custody] FATAL: set DATABASE_URL.');
    process.exit(2);
  }
  const { tenant_id, envelope_ids } = parseArgs(process.argv.slice(2));
  const store = SignArtifactStore.fromEnv(process.env);
  if (!store.enabled) {
    console.error('[artifact-custody] FATAL: SIGN_ARTIFACT_BUCKET is not set.');
    process.exit(2);
  }
  const prisma = new PrismaService(url);
  await prisma.$connect();
  try {
    const rows = await new SignArtifactCustodyRepository(prisma, new EsignRepository(prisma)).readForValidation(tenant_id, envelope_ids);
    const refs = buildCustodyRefs(rows);
    const report = await validateArtifactCustody(refs, { getVersion: (key, version) => store.get(key, version) });
    for (const f of report.findings) {
      console.log(
        `[artifact-custody] ${f.status.padEnd(16)} ${f.kind.padEnd(21)} envelope=${f.envelope_id} artifact=${f.artifact_id} key=${f.object_key ?? '-'} version=${f.version_id ?? '-'}${f.detail ? ` (${f.detail})` : ''}`,
      );
    }
    const counts = Object.entries(report.by_status).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`[artifact-custody] ${report.failures === 0 ? 'OK' : 'FAILED'}: checked=${report.checked} ${counts}`);
    process.exitCode = report.failures === 0 ? 0 : 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  console.error(`[artifact-custody] FATAL: ${(err as Error).message}`);
  process.exit(2);
});
