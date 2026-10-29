import { Test } from '@nestjs/testing';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { DOCUMENT_STORAGE_PORT, EXECUTED_ARTIFACT_CUSTODY_PORT, EXECUTION_PRODUCER_PORT } from '@aramo/sign';

import { AppModule } from '../app/app.module.js';
import { SignArtifactStore } from '../app/custody/sign-artifact-store.js';
import { SignArtifactReconcileWorker } from '../app/custody/sign-artifact-reconcile.worker.js';

// SX-2 — the custody wiring resolves in the real AppModule DI graph (the producer
// receives the custody port; the source adapter receives the Sign store), the feature
// is dark without SIGN_ARTIFACT_BUCKET, and an invalid SIGN_ARTIFACT_RETENTION_DAYS
// refuses to boot (LC-1).

const KEYS = ['DATABASE_URL', 'MAILER_PROVIDER', 'SIGN_ARTIFACT_BUCKET', 'SIGN_ARTIFACT_RETENTION_DAYS'];

describe('sign-service AppModule — SX-2 artifact custody wiring', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = 'postgresql://boot:test@localhost:5432/esign_boot_test';
    process.env['MAILER_PROVIDER'] = 'stub';
  });
  afterEach(() => {
    delete process.env['SIGN_ARTIFACT_BUCKET'];
    delete process.env['SIGN_ARTIFACT_RETENTION_DAYS'];
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('dark by default: the store is disabled, yet the producer and the adapter are wired to it', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const store = moduleRef.get(SignArtifactStore, { strict: false });
    expect(store.enabled).toBe(false);
    const producer = moduleRef.get(EXECUTION_PRODUCER_PORT, { strict: false }) as { custody?: unknown };
    expect(producer.custody).toBe(moduleRef.get(EXECUTED_ARTIFACT_CUSTODY_PORT, { strict: false }));
    const adapter = moduleRef.get(DOCUMENT_STORAGE_PORT, { strict: false }) as { signStore?: unknown };
    expect(adapter.signStore).toBe(store);
    const worker = moduleRef.get(SignArtifactReconcileWorker, { strict: false });
    worker.onApplicationBootstrap();
    expect(worker.scheduled).toBe(false);
    await moduleRef.close();
  });

  it('enabled when SIGN_ARTIFACT_BUCKET is set', async () => {
    process.env['SIGN_ARTIFACT_BUCKET'] = 'aramo-test-sign-artifacts';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(SignArtifactStore, { strict: false }).enabled).toBe(true);
    await moduleRef.close();
  });

  it('an invalid SIGN_ARTIFACT_RETENTION_DAYS refuses to boot', async () => {
    process.env['SIGN_ARTIFACT_BUCKET'] = 'aramo-test-sign-artifacts';
    process.env['SIGN_ARTIFACT_RETENTION_DAYS'] = 'seven-years';
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(/SIGN_ARTIFACT_RETENTION_DAYS/);
  });
});
