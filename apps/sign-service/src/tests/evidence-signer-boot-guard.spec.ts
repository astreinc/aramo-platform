import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVIDENCE_MANIFEST_SIGNER_PORT, SoftwareEvidenceManifestSigner } from '@aramo/sign';

import { AppModule } from '../app/app.module.js';

// SX-1 item 4 — the REAL composition root: the full AppModule refuses to come up
// with NODE_ENV=production and no SIGN_KMS_KEY_ID; outside production it binds the
// software signer. compile() resolves the DI graph (incl. the async signer
// factory) without opening the DB.

const KEYS = ['DATABASE_URL', 'MAILER_PROVIDER', 'NODE_ENV', 'SIGN_KMS_KEY_ID'] as const;

describe('sign-service AppModule evidence-signer boot guard (SX-1 item 4)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = 'postgresql://boot:test@localhost:5432/esign_boot_test';
    process.env['MAILER_PROVIDER'] = 'stub';
    delete process.env['SIGN_KMS_KEY_ID'];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('refuses to compile in production without SIGN_KMS_KEY_ID', async () => {
    process.env['NODE_ENV'] = 'production';
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(
      /refuses to start.*SIGN_KMS_KEY_ID/,
    );
  });

  it('binds the software signer outside production', async () => {
    process.env['NODE_ENV'] = 'test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(EVIDENCE_MANIFEST_SIGNER_PORT, { strict: false })).toBeInstanceOf(SoftwareEvidenceManifestSigner);
    await moduleRef.close();
  });
});
