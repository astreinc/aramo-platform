import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { EXECUTED_ARTIFACT_CUSTODY_EVENT_TYPE, SignArtifactCustodyRepository } from '@aramo/sign';

import {
  isSignSourceKey,
  loadSignArtifactStorageConfig,
  parseRetentionDays,
  signCertificateKey,
  signEvidenceKey,
  signExecutedKey,
  signSourceKey,
} from '../app/custody/sign-artifact-storage.config.js';
import { SignArtifactStore } from '../app/custody/sign-artifact-store.js';
import { ExecutedArtifactCustodyService } from '../app/custody/executed-artifact-custody.service.js';
import { SignArtifactReconcileWorker } from '../app/custody/sign-artifact-reconcile.worker.js';
import { buildCustodyRefs, validateArtifactCustody } from '../app/custody/artifact-custody-validation.js';
import { EsignObjectStorageDocumentAdapter } from '../app/esign-object-storage-document.adapter.js';

import { FakeSignS3, TEST_SIGN_BUCKET, fakeStore } from './fixtures/fake-sign-s3.js';

// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 — unit
// coverage of the dedicated Sign artifact storage: dark by default, LC-1 retention
// (no default; GOVERNANCE only when set; invalid refuses), tenant-first keys, source
// delete never names a version, completion custody that never fails completion,
// idempotent reconcile, and the read-only recovery validation.

const T = '11111111-1111-4111-8111-111111111111';
const E = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';
const O = '44444444-4444-4444-8444-444444444444';
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const b64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');

describe('SX-2 config — dark by default, LC-1 retention', () => {
  it('is dark (null) when SIGN_ARTIFACT_BUCKET is unset or empty', () => {
    expect(loadSignArtifactStorageConfig({})).toBeNull();
    expect(loadSignArtifactStorageConfig({ SIGN_ARTIFACT_BUCKET: '   ' })).toBeNull();
    expect(SignArtifactStore.fromEnv({}).enabled).toBe(false);
  });

  it('never reads S3_RESUME_BUCKET or the shared AWS_* key', () => {
    const cfg = loadSignArtifactStorageConfig({ S3_RESUME_BUCKET: 'resumes', AWS_ACCESS_KEY_ID: 'AKIASHARED', AWS_SECRET_ACCESS_KEY: 'shared' });
    expect(cfg).toBeNull();
    const on = loadSignArtifactStorageConfig({ SIGN_ARTIFACT_BUCKET: 'sign-b', S3_RESUME_BUCKET: 'resumes', AWS_ACCESS_KEY_ID: 'AKIASHARED', AWS_SECRET_ACCESS_KEY: 'shared' });
    expect(on).toMatchObject({ bucket: 'sign-b', credentials: null });
  });

  it('uses the explicit Sign key pair when both are set; one without the other refuses', () => {
    expect(loadSignArtifactStorageConfig({ SIGN_ARTIFACT_BUCKET: 'b', SIGN_ARTIFACT_AWS_ACCESS_KEY_ID: 'AKIASIGN', SIGN_ARTIFACT_AWS_SECRET_ACCESS_KEY: 's' })?.credentials).toEqual({ accessKeyId: 'AKIASIGN', secretAccessKey: 's' });
    expect(() => loadSignArtifactStorageConfig({ SIGN_ARTIFACT_BUCKET: 'b', SIGN_ARTIFACT_AWS_ACCESS_KEY_ID: 'AKIASIGN' })).toThrow(/set together/);
  });

  it('retention unset/empty => null (no default period)', () => {
    expect(parseRetentionDays(null)).toBeNull();
    expect(loadSignArtifactStorageConfig({ SIGN_ARTIFACT_BUCKET: 'b' })?.retentionDays).toBeNull();
    expect(loadSignArtifactStorageConfig({ SIGN_ARTIFACT_BUCKET: 'b', SIGN_ARTIFACT_RETENTION_DAYS: '' })?.retentionDays).toBeNull();
  });

  it('retention set => a positive integer is accepted', () => {
    expect(loadSignArtifactStorageConfig({ SIGN_ARTIFACT_BUCKET: 'b', SIGN_ARTIFACT_RETENTION_DAYS: '30' })?.retentionDays).toBe(30);
  });

  it.each(['0', '-1', 'abc', '7.5', '1e3', '30d', '36501', '99999999999999999999'])('invalid retention "%s" refuses (also while dark)', (v) => {
    expect(() => loadSignArtifactStorageConfig({ SIGN_ARTIFACT_BUCKET: 'b', SIGN_ARTIFACT_RETENTION_DAYS: v })).toThrow(/SIGN_ARTIFACT_RETENTION_DAYS/);
    expect(() => SignArtifactStore.fromEnv({ SIGN_ARTIFACT_RETENTION_DAYS: v })).toThrow(/SIGN_ARTIFACT_RETENTION_DAYS/);
  });

  it('an endpoint switches to path-style (LocalStack)', () => {
    expect(loadSignArtifactStorageConfig({ SIGN_ARTIFACT_BUCKET: 'b', SIGN_ARTIFACT_S3_ENDPOINT: 'http://localhost:4566' })).toMatchObject({ endpoint: 'http://localhost:4566', forcePathStyle: true });
  });
});

describe('SX-2 key layout — tenant first', () => {
  it('builds the four directive keys', () => {
    const h = 'a'.repeat(64);
    expect(signSourceKey(T, E, O)).toBe(`tenants/${T}/envelopes/${E}/source/${O}`);
    expect(signExecutedKey(T, E, D, h)).toBe(`tenants/${T}/envelopes/${E}/executed/${D}/${h}.pdf`);
    expect(signCertificateKey(T, E, h)).toBe(`tenants/${T}/envelopes/${E}/certificate/${h}.pdf`);
    expect(signEvidenceKey(T, E, h)).toBe(`tenants/${T}/envelopes/${E}/evidence/${h}.json`);
  });

  it('refuses non-UUID segments and non-hex hashes', () => {
    expect(() => signSourceKey('../x', E, O)).toThrow(/tenant_id/);
    expect(() => signCertificateKey(T, E, 'ABC')).toThrow(/sha256/);
  });

  it('only source keys are deletable', () => {
    expect(isSignSourceKey(signSourceKey(T, E, O))).toBe(true);
    expect(isSignSourceKey(signExecutedKey(T, E, D, 'b'.repeat(64)))).toBe(false);
    expect(isSignSourceKey(`esign/source/${T}/${E}/${O}`)).toBe(false);
  });
});

describe('SX-2 SignArtifactStore — S3 parameters', () => {
  const body = Buffer.from('%PDF-executed');
  const h = sha(body);

  it('retention unset => no ObjectLock parameters; checksum always sent', async () => {
    const fake = new FakeSignS3();
    const out = await fakeStore(fake).putArtifact({ key: signCertificateKey(T, E, h), body, content_type: 'application/pdf', sha256: h });
    const put = fake.callsOf('PutObjectCommand')[0]!;
    expect(put).toMatchObject({ Bucket: TEST_SIGN_BUCKET, ChecksumAlgorithm: 'SHA256', ChecksumSHA256: b64(h) });
    expect(put).not.toHaveProperty('ObjectLockMode');
    expect(put).not.toHaveProperty('ObjectLockRetainUntilDate');
    // SSE is the bucket default (Sign CMK): no per-request override.
    expect(put).not.toHaveProperty('ServerSideEncryption');
    expect(out.retain_until).toBeNull();
    expect(out.version_id).toMatch(/^v/);
  });

  it('retention set => GOVERNANCE + retain-until = now + days', async () => {
    const fake = new FakeSignS3();
    const now = new Date('2026-10-29T00:00:00Z');
    const out = await fakeStore(fake, { retentionDays: 10 }).putArtifact({ key: signCertificateKey(T, E, h), body, content_type: 'application/pdf', sha256: h, now });
    const put = fake.callsOf('PutObjectCommand')[0]!;
    expect(put['ObjectLockMode']).toBe('GOVERNANCE');
    expect((put['ObjectLockRetainUntilDate'] as Date).toISOString()).toBe('2026-11-08T00:00:00.000Z');
    expect(out.retain_until?.toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });

  it('source uploads never carry retention, even when retention is configured', async () => {
    const fake = new FakeSignS3();
    await fakeStore(fake, { retentionDays: 10 }).putSource({ key: signSourceKey(T, E, O), body, content_type: 'application/pdf' });
    expect(fake.callsOf('PutObjectCommand')[0]).not.toHaveProperty('ObjectLockMode');
  });

  it('an artifact upload without a version id is refused (versioning required)', async () => {
    const fake = new FakeSignS3();
    fake.versioning = false;
    await expect(fakeStore(fake).putArtifact({ key: signCertificateKey(T, E, h), body, content_type: 'application/pdf', sha256: h })).rejects.toThrow(/version id/);
  });

  it('source delete removes the current object only — never a version; non-source keys refused', async () => {
    const fake = new FakeSignS3();
    const store = fakeStore(fake);
    const key = signSourceKey(T, E, O);
    fake.seed(key, body);
    await store.deleteSource(key);
    const del = fake.callsOf('DeleteObjectCommand');
    expect(del).toHaveLength(1);
    expect(del[0]).not.toHaveProperty('VersionId');
    expect(fake.objects.get(key)?.filter((v) => !v.delete_marker)).toHaveLength(1); // prior version kept
    await expect(store.deleteSource(signExecutedKey(T, E, D, h))).rejects.toThrow(/source/);
    expect(fake.callsOf('DeleteObjectCommand')).toHaveLength(1);
  });

  it('a dark store refuses every S3 call', async () => {
    const store = new SignArtifactStore(null);
    await expect(store.get('tenants/x')).rejects.toThrow(/not configured/);
  });
});

describe('SX-2 OWNED source adapter — routing by key prefix', () => {
  function legacy() {
    return {
      putObjectBytes: vi.fn(async () => ({ storage_ref: 'x', sha256: 'y' })),
      getObjectBytes: vi.fn(async () => Buffer.from('legacy')),
      deleteObjectByKey: vi.fn(async () => undefined),
    };
  }
  const bytes = new Uint8Array(Buffer.from('%PDF-source'));

  it('dark: new sources go to the platform bucket under esign/source/ (unchanged)', async () => {
    const storage = legacy();
    const adapter = new EsignObjectStorageDocumentAdapter(storage as never, new SignArtifactStore(null));
    const out = await adapter.putOwnedSource({ tenant_id: T, envelope_id: E, filename: 'a.pdf', content_type: 'application/pdf', bytes, object_id: O });
    expect(out.source_object_key).toBe(`esign/source/${T}/${E}/${O}`);
    expect(adapter.plannedSourceKey(T, E, O)).toBe(out.source_object_key);
    expect(storage.putObjectBytes).toHaveBeenCalledTimes(1);
  });

  it('dark with no store bound at all behaves the same', async () => {
    const storage = legacy();
    const adapter = new EsignObjectStorageDocumentAdapter(storage as never);
    const out = await adapter.putOwnedSource({ tenant_id: T, envelope_id: E, filename: 'a.pdf', content_type: 'application/pdf', bytes, object_id: O });
    expect(out.source_object_key.startsWith('esign/source/')).toBe(true);
  });

  it('enabled: new sources go to the Sign bucket under the tenant-first key', async () => {
    const storage = legacy();
    const fake = new FakeSignS3();
    const adapter = new EsignObjectStorageDocumentAdapter(storage as never, fakeStore(fake));
    const out = await adapter.putOwnedSource({ tenant_id: T, envelope_id: E, filename: 'a.pdf', content_type: 'application/pdf', bytes, object_id: O });
    expect(out).toEqual({ source_object_key: signSourceKey(T, E, O), byte_size: bytes.byteLength, source_sha256: sha(bytes) });
    expect(adapter.plannedSourceKey(T, E, O)).toBe(out.source_object_key);
    expect(storage.putObjectBytes).not.toHaveBeenCalled();
    expect(fake.current(out.source_object_key)?.body.toString()).toBe('%PDF-source');
  });

  it('reads: legacy esign/source/ keys from the platform bucket, tenants/ keys from the Sign bucket', async () => {
    const storage = legacy();
    const fake = new FakeSignS3();
    fake.seed(signSourceKey(T, E, O), Buffer.from('sign-bytes'));
    const adapter = new EsignObjectStorageDocumentAdapter(storage as never, fakeStore(fake));
    expect(Buffer.from(await adapter.getOwnedSource(`esign/source/${T}/${E}/${O}`)).toString()).toBe('legacy');
    expect(Buffer.from(await adapter.getOwnedSource(signSourceKey(T, E, O))).toString()).toBe('sign-bytes');
    expect(storage.getObjectBytes).toHaveBeenCalledTimes(1);
  });

  it('a tenants/ key while dark fails closed (never falls back to the platform bucket)', async () => {
    const storage = legacy();
    const adapter = new EsignObjectStorageDocumentAdapter(storage as never, new SignArtifactStore(null));
    await expect(adapter.getOwnedSource(signSourceKey(T, E, O))).rejects.toThrow(/not configured/);
    expect(storage.getObjectBytes).not.toHaveBeenCalled();
  });

  it('draft delete: Sign source keys delete the current object only; artifact keys are refused', async () => {
    const storage = legacy();
    const fake = new FakeSignS3();
    const adapter = new EsignObjectStorageDocumentAdapter(storage as never, fakeStore(fake));
    await adapter.deleteOwnedSource(signSourceKey(T, E, O));
    expect(fake.callsOf('DeleteObjectCommand')[0]).not.toHaveProperty('VersionId');
    await expect(adapter.deleteOwnedSource(signExecutedKey(T, E, D, 'c'.repeat(64)))).rejects.toThrow(/source object key/);
    await adapter.deleteOwnedSource(`esign/source/${T}/${E}/${O}`);
    expect(storage.deleteObjectByKey).toHaveBeenCalledTimes(1);
    expect(fake.callsOf('DeleteObjectCommand')).toHaveLength(1);
  });
});

// ── Completion custody + reconcile against an in-memory row store ──

interface Row { [k: string]: unknown }

function harness(opts: { executed?: Row[]; certificate?: Row | null; evidenceFails?: boolean } = {}) {
  const executed: Row[] = opts.executed ?? [];
  const certs: Row[] = opts.certificate ? [opts.certificate] : [];
  const matches = (r: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && 'lt' in (v as Row)) return (r[k] as Date) < ((v as Row)['lt'] as Date);
      return (r[k] ?? null) === v;
    });
  const table = (rows: Row[]) => ({
    findMany: async (q: { where: Row; take?: number }) => rows.filter((r) => matches(r, q.where)).slice(0, q.take ?? rows.length),
    findFirst: async (q: { where: Row }) => rows.find((r) => matches(r, q.where)) ?? null,
    updateMany: async (q: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, q.where));
      for (const r of hit) Object.assign(r, q.data);
      return { count: hit.length };
    },
  });
  const tx = { executedDocument: table(executed), executionCertificate: table(certs) };
  const prisma = { ...tx, $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const events: Array<Record<string, unknown>> = [];
  const repo = {
    lockEnvelope: vi.fn(async () => 'COMPLETED'),
    appendEvent: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => { events.push(input); return 'h'; }),
  };
  const evidenceManifest = vi.fn(async () => {
    if (opts.evidenceFails) throw new Error('manifest unavailable');
    return { manifest: { envelope_id: E }, signature: 'sig', signature_algorithm: 'SHA256-SOFTWARE-DOC3', kms_key_version_ref: null, signing_timestamp: 't' };
  });
  const moduleRef = { get: () => ({ evidenceManifest }) };
  return { executed, certs, prisma, repo, events, moduleRef, evidenceManifest };
}

function executedRow(bytes: Buffer, over: Row = {}): Row {
  return {
    id: randomUUID(), tenant_id: T, envelope_id: E, envelope_document_id: D, source_sha256: 's', executed_sha256: sha(bytes),
    byte_size: bytes.byteLength, executed_bytes: bytes, produced_at: new Date('2026-10-29T00:00:00Z'),
    custody_object_key: null, custody_version_id: null, custody_sha256: null, custody_retain_until: null, custody_stored_at: null, ...over,
  };
}
function certRow(bytes: Buffer, over: Row = {}): Row {
  return {
    id: randomUUID(), tenant_id: T, envelope_id: E, certificate_sha256: sha(bytes), byte_size: bytes.byteLength, certificate_bytes: bytes,
    produced_at: new Date('2026-10-29T00:00:00Z'),
    custody_object_key: null, custody_version_id: null, custody_sha256: null, custody_retain_until: null, custody_stored_at: null, ...over,
  };
}

function service(h: ReturnType<typeof harness>, store: SignArtifactStore): ExecutedArtifactCustodyService {
  return new ExecutedArtifactCustodyService(new SignArtifactCustodyRepository(h.prisma as never, h.repo as never), store, h.moduleRef as never);
}

describe('SX-2 completion custody', () => {
  const pdf = Buffer.from('%PDF-executed-1');
  const cert = Buffer.from('%PDF-certificate');

  it('dark: recordCompletion does nothing', async () => {
    const h = harness({ executed: [executedRow(pdf)], certificate: certRow(cert) });
    await service(h, new SignArtifactStore(null)).recordCompletion(T, E);
    expect(h.executed[0]!['custody_object_key']).toBeNull();
    expect(h.repo.appendEvent).not.toHaveBeenCalled();
  });

  it('uploads executed + evidence + certificate, sets custody NULL->value and appends ledger events', async () => {
    const h = harness({ executed: [executedRow(pdf)], certificate: certRow(cert) });
    const fake = new FakeSignS3();
    await service(h, fakeStore(fake, { retentionDays: 5 })).recordCompletion(T, E);

    const puts = fake.callsOf('PutObjectCommand').map((p) => p['Key'] as string);
    expect(puts).toHaveLength(3);
    // Evidence first (captured before any custody event is appended), then executed, then certificate.
    expect(puts[0]).toMatch(new RegExp(`^tenants/${T}/envelopes/${E}/evidence/[0-9a-f]{64}\\.json$`));
    expect(puts[1]).toBe(signExecutedKey(T, E, D, sha(pdf)));
    expect(puts[2]).toBe(signCertificateKey(T, E, sha(cert)));
    for (const p of fake.callsOf('PutObjectCommand')) expect(p['ObjectLockMode']).toBe('GOVERNANCE');

    const ex = h.executed[0]!;
    expect(ex).toMatchObject({ custody_object_key: puts[1], custody_sha256: sha(pdf) });
    expect(ex['custody_version_id']).toMatch(/^v/);
    expect(ex['custody_retain_until']).toBeInstanceOf(Date);
    expect(ex['custody_stored_at']).toBeInstanceOf(Date);
    expect(h.certs[0]).toMatchObject({ custody_object_key: puts[2], custody_sha256: sha(cert) });

    expect(h.events).toHaveLength(2);
    expect(h.events.every((e) => e['event_type'] === EXECUTED_ARTIFACT_CUSTODY_EVENT_TYPE)).toBe(true);
    const certEvent = h.events[1]!['payload'] as Record<string, unknown>;
    expect(certEvent).toMatchObject({ artifact_kind: 'EXECUTION_CERTIFICATE', sha256: sha(cert), retention_mode: 'GOVERNANCE', bucket: TEST_SIGN_BUCKET });
    const evidence = certEvent['evidence'] as Record<string, unknown>;
    expect(evidence['object_key']).toBe(puts[0]);
    // The evidence object's bytes hash to the recorded sha and carry the manifest.
    const stored = fake.current(puts[0]!)!.body;
    expect(sha(stored)).toBe(evidence['sha256']);
    expect(JSON.parse(stored.toString())).toMatchObject({ schema: 'aramo.sign.evidence-snapshot.v1', evidence: { signature: 'sig' } });
  });

  it('retention unset: custody recorded with no retain-until and no ObjectLock parameters', async () => {
    const h = harness({ executed: [executedRow(pdf)], certificate: certRow(cert) });
    const fake = new FakeSignS3();
    await service(h, fakeStore(fake)).recordCompletion(T, E);
    for (const p of fake.callsOf('PutObjectCommand')) expect(p).not.toHaveProperty('ObjectLockMode');
    expect(h.executed[0]!['custody_retain_until']).toBeNull();
    expect((h.events[0]!['payload'] as Record<string, unknown>)['retention_mode']).toBeNull();
  });

  it('an upload failure never throws and leaves custody NULL', async () => {
    const h = harness({ executed: [executedRow(pdf)], certificate: certRow(cert) });
    const fake = new FakeSignS3();
    fake.failOn = { name: 'PutObjectCommand', error: new Error('AccessDenied'), times: 99 };
    await expect(service(h, fakeStore(fake)).recordCompletion(T, E)).resolves.toBeUndefined();
    expect(h.executed[0]!['custody_object_key']).toBeNull();
    expect(h.certs[0]!['custody_object_key']).toBeNull();
    expect(h.repo.appendEvent).not.toHaveBeenCalled();
  });

  it('evidence failure leaves the certificate custody NULL (executed still recorded)', async () => {
    const h = harness({ executed: [executedRow(pdf)], certificate: certRow(cert), evidenceFails: true });
    const fake = new FakeSignS3();
    const out = await service(h, fakeStore(fake)).custodyForEnvelope(T, E);
    expect(out).toEqual({ recorded: 1, adopted: 0, failed: 1 });
    expect(h.executed[0]!['custody_object_key']).not.toBeNull();
    expect(h.certs[0]!['custody_object_key']).toBeNull();
  });

  it('refuses custody when the row bytes no longer match the recorded sha256', async () => {
    const h = harness({ executed: [executedRow(pdf, { executed_sha256: 'f'.repeat(64) })] });
    const fake = new FakeSignS3();
    const out = await service(h, fakeStore(fake)).custodyForEnvelope(T, E);
    expect(out.failed).toBe(1);
    expect(fake.callsOf('PutObjectCommand')).toHaveLength(0);
  });

  it('a recorded custody is never overwritten (NULL->value only)', async () => {
    const h = harness({ executed: [executedRow(pdf, { custody_object_key: 'k', custody_version_id: 'v0', custody_sha256: sha(pdf), custody_stored_at: new Date() })] });
    const fake = new FakeSignS3();
    await service(h, fakeStore(fake)).recordCompletion(T, E);
    expect(fake.callsOf('PutObjectCommand')).toHaveLength(0);
    expect(h.executed[0]!['custody_version_id']).toBe('v0');
  });
});

describe('SX-2 reconcile', () => {
  const pdf = Buffer.from('%PDF-executed-2');
  const cert = Buffer.from('%PDF-certificate-2');
  const now = new Date('2026-10-29T01:00:00Z');

  it('retries a failed upload and records it', async () => {
    const h = harness({ executed: [executedRow(pdf)], certificate: certRow(cert) });
    const fake = new FakeSignS3();
    const svc = service(h, fakeStore(fake));
    fake.failOn = { name: 'PutObjectCommand', error: new Error('SlowDown'), times: 99 };
    await svc.recordCompletion(T, E);
    expect(h.executed[0]!['custody_object_key']).toBeNull();
    fake.failOn = null;
    const report = await svc.reconcile({ now });
    expect(report).toEqual({ envelopes: 1, recorded: 2, adopted: 0, failed: 0 });
    expect(h.executed[0]!['custody_object_key']).not.toBeNull();
    expect(h.certs[0]!['custody_object_key']).not.toBeNull();
    // A second run finds nothing to do (idempotent).
    expect(await svc.reconcile({ now })).toEqual({ envelopes: 0, recorded: 0, adopted: 0, failed: 0 });
    expect(h.events).toHaveLength(2);
  });

  it('adopts an object already stored with a matching checksum (no re-upload)', async () => {
    const h = harness({ executed: [executedRow(pdf)] });
    const fake = new FakeSignS3();
    const key = signExecutedKey(T, E, D, sha(pdf));
    const vid = fake.seed(key, pdf);
    const report = await service(h, fakeStore(fake)).reconcile({ now });
    expect(report).toEqual({ envelopes: 1, recorded: 1, adopted: 1, failed: 0 });
    expect(fake.callsOf('PutObjectCommand')).toHaveLength(0);
    expect(h.executed[0]).toMatchObject({ custody_object_key: key, custody_version_id: vid });
  });

  it('re-uploads when the existing object has no matching checksum', async () => {
    const h = harness({ executed: [executedRow(pdf)] });
    const fake = new FakeSignS3();
    fake.seed(signExecutedKey(T, E, D, sha(pdf)), pdf, { checksum: false });
    const report = await service(h, fakeStore(fake)).reconcile({ now });
    expect(report.adopted).toBe(0);
    expect(fake.callsOf('PutObjectCommand')).toHaveLength(1);
  });

  it('skips rows younger than the minimum age (left to the inline upload)', async () => {
    const h = harness({ executed: [executedRow(pdf, { produced_at: new Date(now.getTime() - 1_000) })] });
    const fake = new FakeSignS3();
    expect((await service(h, fakeStore(fake)).reconcile({ now })).envelopes).toBe(0);
  });

  it('dark: the worker is never scheduled and reconcile is a no-op', async () => {
    const h = harness({ executed: [executedRow(pdf)] });
    const svc = service(h, new SignArtifactStore(null));
    const worker = new SignArtifactReconcileWorker(svc);
    worker.onApplicationBootstrap();
    expect(worker.scheduled).toBe(false);
    expect(await svc.reconcile({ now })).toEqual({ envelopes: 0, recorded: 0, adopted: 0, failed: 0 });
  });

  it('enabled: the worker schedules and a tick runs one reconcile', async () => {
    const h = harness({ executed: [executedRow(pdf)] });
    const fake = new FakeSignS3();
    const svc = service(h, fakeStore(fake));
    const spy = vi.spyOn(svc, 'reconcile');
    const worker = new SignArtifactReconcileWorker(svc);
    worker.onApplicationBootstrap();
    expect(worker.scheduled).toBe(true);
    await worker.tick();
    expect(spy).toHaveBeenCalledTimes(1);
    await worker.onApplicationShutdown();
    expect(worker.scheduled).toBe(false);
  });
});

describe('SX-2 recovery validation (read-only)', () => {
  const pdf = Buffer.from('%PDF-executed-3');
  const cert = Buffer.from('%PDF-certificate-3');

  async function recorded() {
    const h = harness({ executed: [executedRow(pdf)], certificate: certRow(cert) });
    const fake = new FakeSignS3();
    const store = fakeStore(fake);
    await service(h, store).recordCompletion(T, E);
    const events = h.events.map((e) => ({ envelope_id: E, payload: e['payload'] }));
    return { h, fake, store, events };
  }

  it('all artifacts (executed, certificate, evidence) verify OK by version id', async () => {
    const { h, fake, store, events } = await recorded();
    const refs = buildCustodyRefs({ executed: h.executed as never, certificates: h.certs as never, events });
    const report = await validateArtifactCustody(refs, { getVersion: (k, v) => store.get(k, v) });
    expect(report).toMatchObject({ checked: 3, ok: 3, failures: 0 });
    const gets = fake.callsOf('GetObjectCommand');
    expect(gets).toHaveLength(3);
    for (const g of gets) expect(typeof g['VersionId']).toBe('string');
    // Read-only: nothing written or deleted.
    expect(fake.callsOf('PutObjectCommand')).toHaveLength(3);
    expect(fake.callsOf('DeleteObjectCommand')).toHaveLength(0);
  });

  it('detects a content mismatch, a missing version, a missing custody and a ledger mismatch', async () => {
    const { h, fake, store, events } = await recorded();
    // Tamper: the recorded executed version's bytes no longer hash to the row.
    const exKey = h.executed[0]!['custody_object_key'] as string;
    fake.objects.get(exKey)![0]!.body = Buffer.from('tampered');
    // The certificate's version id points at a version that does not exist.
    h.certs[0]!['custody_version_id'] = 'v-gone';
    // A second executed row whose custody was never recorded.
    const pending = executedRow(Buffer.from('%PDF-other'), { envelope_document_id: randomUUID() });
    const refs = buildCustodyRefs({ executed: [...h.executed, pending] as never, certificates: h.certs as never, events });
    const report = await validateArtifactCustody(refs, { getVersion: (k, v) => store.get(k, v) });
    expect(report.by_status).toMatchObject({ CONTENT_MISMATCH: 1, LEDGER_MISMATCH: 1, MISSING_CUSTODY: 1, OK: 1 });
    expect(report.failures).toBe(3);

    // A version that is simply absent (no ledger to compare) => FETCH_FAILED.
    const bare = buildCustodyRefs({ executed: [], certificates: h.certs as never, events: [] });
    const r2 = await validateArtifactCustody(bare, { getVersion: (k, v) => store.get(k, v) });
    expect(r2.by_status.FETCH_FAILED).toBe(1);
  });

  it('a custody sha that differs from the row is a record mismatch (no fetch)', async () => {
    const getVersion = vi.fn();
    const report = await validateArtifactCustody(
      [{ kind: 'EXECUTED_DOCUMENT', artifact_id: 'a', tenant_id: T, envelope_id: E, expected_sha256: 'a'.repeat(64), custody_object_key: 'k', custody_version_id: 'v', custody_sha256: 'b'.repeat(64) }],
      { getVersion },
    );
    expect(report.by_status.RECORD_MISMATCH).toBe(1);
    expect(getVersion).not.toHaveBeenCalled();
  });
});
