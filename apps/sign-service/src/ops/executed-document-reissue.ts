// Aramo-Sign-Mobile-Amendment-M-A13-Field-Test-Remediation-v1_0-LOCKED R-1b — the
// typed-signature defect's corrected reissue, as an operator command.
//
//   inventory  READ-ONLY. Counts and lists (ids only, never a field value) the executed
//              documents with a SIGNATURE / INITIALS field stored as TYPED whose value is
//              an image data URL. Runs in a READ ONLY transaction; writes nothing.
//   reissue    The append-only corrected reissue of the named envelopes. DRY RUN unless
//              --apply is given: a dry run renders the corrected copies and prints the
//              original and corrected SHA-256 and writes nothing. With --apply, each
//              envelope gets ExecutedDocumentReissue rows + EXECUTED_DOCUMENT_REISSUED
//              ledger events and a reissued certificate (EXECUTION_CERTIFICATE_REISSUED).
//              The original ExecutedDocument / ExecutionCertificate rows are never changed.
//
// ⛔ Running `reissue --apply` in production needs separate PO authorization, after the
// read-only inventory count has been reported (directive R-1b).
//
// Usage (env: DATABASE_URL; reissue also needs the source-storage settings of the
// sign-service: SIGN_ARTIFACT_*, the platform object-storage env, DOCUMENTS_API_URL +
// SIGN_WEBHOOK_SIGNING_SECRET for CORE_REF sources):
//   npm run sign:executed-reissue -- inventory [--tenant <uuid>] [--envelope <uuid> ...]
//   npm run sign:executed-reissue -- reissue --tenant <uuid> --envelope <uuid> [...] --reason "<text>" [--apply]
// In the sign-service image:
//   node dist/apps/sign-service/src/ops/executed-document-reissue.js inventory
import { createAramoLogger } from '@aramo/common';
import { PdfLibDocumentRenderingAdapter } from '@aramo/documents-rendering';
import { ObjectStorageService, S3ClientFactory } from '@aramo/object-storage';
import { EsignRepository, ExecutionService, PrismaService, findReissueInventory } from '@aramo/sign';

import { DocumentSourceHttpAdapter } from '../app/document-source-http.adapter.js';
import { EnvelopeDocumentSourceResolver } from '../app/envelope-document-source.resolver.js';
import { EsignObjectStorageDocumentAdapter } from '../app/esign-object-storage-document.adapter.js';
import { SignArtifactStore } from '../app/custody/sign-artifact-store.js';

import { parseReissueArgs, type ReissueCommand } from './executed-document-reissue.args.js';

const TAG = '[executed-reissue]';

async function inventory(prisma: PrismaService, cmd: Extract<ReissueCommand, { mode: 'inventory' }>): Promise<void> {
  const report = await findReissueInventory(prisma, {
    ...(cmd.tenant_id !== undefined ? { tenant_id: cmd.tenant_id } : {}),
    envelope_ids: cmd.envelope_ids,
  });
  for (const c of report.affected) {
    console.log(
      `${TAG} AFFECTED tenant=${c.tenant_id} envelope=${c.envelope_id} document=${c.envelope_document_id} executed=${c.executed_document_id} fields=${c.affected_fields}${c.purged ? ' PURGED' : ''}${c.already_reissued ? ' ALREADY_REISSUED' : ''}`,
    );
  }
  const pending = report.affected.filter((c) => !c.purged && !c.already_reissued).length;
  console.log(
    `${TAG} executed_documents=${report.executed_documents} envelopes=${report.envelopes} tenants=${report.tenants} affected_fields=${report.affected_fields} pending_reissue=${pending}`,
  );
}

async function reissue(prisma: PrismaService, cmd: Extract<ReissueCommand, { mode: 'reissue' }>): Promise<number> {
  const env = process.env;
  const objectStorage = new ObjectStorageService(new S3ClientFactory(), createAramoLogger(ObjectStorageService.name));
  const source = new EnvelopeDocumentSourceResolver(
    new DocumentSourceHttpAdapter(),
    new EsignObjectStorageDocumentAdapter(objectStorage, SignArtifactStore.fromEnv(env)),
  );
  const repo = new EsignRepository(prisma);
  const execution = new ExecutionService(prisma, repo, new PdfLibDocumentRenderingAdapter(), source);
  let failures = 0;
  console.log(`${TAG} ${cmd.apply ? 'APPLY' : 'DRY RUN (nothing is written; add --apply to reissue)'}`);
  for (const envelope_id of cmd.envelope_ids) {
    try {
      const out = await execution.reissueCorrected(cmd.tenant_id, envelope_id, { reason: cmd.reason, apply: cmd.apply });
      for (const d of out.documents) {
        console.log(`${TAG} ${out.status.toUpperCase()} envelope=${envelope_id} document=${d.envelope_document_id} original=${d.original_sha256} corrected=${d.sha256}${d.artifact_id !== null ? ` reissue=${d.artifact_id}` : ''}`);
      }
      if (out.certificate !== null) {
        console.log(`${TAG} CERTIFICATE envelope=${envelope_id} original=${out.certificate.original_sha256} reissued=${out.certificate.sha256} reissue=${out.certificate.artifact_id}`);
      }
      if (out.documents.length === 0) console.log(`${TAG} ${out.status.toUpperCase()} envelope=${envelope_id}`);
    } catch (e) {
      failures += 1;
      console.error(`${TAG} REFUSED envelope=${envelope_id}: ${(e as Error).message}`);
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error(`${TAG} FATAL: set DATABASE_URL.`);
    process.exit(2);
  }
  // Under deploy/jiti-tsconfig-runner.mjs the entry path is argv[2]; under node it is argv[1].
  const args = process.argv.slice(2);
  if (args[0] !== undefined && /executed-document-reissue\.(ts|js)$/.test(args[0])) args.shift();
  const cmd = parseReissueArgs(args);
  const prisma = new PrismaService(url);
  await prisma.$connect();
  try {
    if (cmd.mode === 'inventory') await inventory(prisma, cmd);
    else process.exitCode = (await reissue(prisma, cmd)) === 0 ? 0 : 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  console.error(`${TAG} FATAL: ${(err as Error).message}`);
  process.exit(2);
});
