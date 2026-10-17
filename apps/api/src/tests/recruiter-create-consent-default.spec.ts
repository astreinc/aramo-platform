import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { AuthContextType } from '@aramo/auth';
import type { ConsentService } from '@aramo/consent';
import {
  RECRUITER_CREATE_CONSENT_DEFAULT,
  TalentRecordController,
} from '@aramo/talent-record';

import { AppModule } from '../app.module.js';
import { RecruiterCreateConsentDefaultAdapter } from '../talent-consent-default/recruiter-create-consent-default.adapter.js';

// CONSENT-RECRUITER-CREATE-DEFAULT-1 (Amendment v1.0 LOCKED §6) — the composition-
// root binding of talent-record's RECRUITER_CREATE_CONSENT_DEFAULT port to the
// ConsentService adapter (no new nx edge between the two libs).

const AUTH = {
  sub: 'recruiter-1',
  tenant_id: 'tenant-1',
  consumer_type: 'recruiter',
} as unknown as AuthContextType;

describe('RecruiterCreateConsentDefaultAdapter', () => {
  it('delegates to ConsentService.recordRecruiterCreateDefault (the one consent writer)', async () => {
    const recordRecruiterCreateDefault = vi
      .fn()
      .mockResolvedValue({ status: 'recorded', results: [] });
    const adapter = new RecruiterCreateConsentDefaultAdapter({
      recordRecruiterCreateDefault,
    } as unknown as ConsentService);
    await adapter.recordDefault({ talent_record_id: 'tal-1', authContext: AUTH, requestId: 'rq-1' });
    expect(recordRecruiterCreateDefault).toHaveBeenCalledWith({
      talent_record_id: 'tal-1',
      authContext: AUTH,
      requestId: 'rq-1',
    });
  });

  it('propagates a consent failure (the talent-record caller owns the fail-soft)', async () => {
    const adapter = new RecruiterCreateConsentDefaultAdapter({
      recordRecruiterCreateDefault: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as ConsentService);
    await expect(
      adapter.recordDefault({ talent_record_id: 'tal-1', authContext: AUTH, requestId: 'rq-1' }),
    ).rejects.toThrow('boom');
  });
});

describe('AppModule — RECRUITER_CREATE_CONSENT_DEFAULT is bound and injected', () => {
  const savedEnv: Partial<Record<string, string | undefined>> = {};
  let module: TestingModule | undefined;

  beforeAll(async () => {
    for (const k of ['DATABASE_URL', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) savedEnv[k] = process.env[k];
    process.env['DATABASE_URL'] = 'postgres://stub:stub@127.0.0.1:1/stub';
    process.env['AUTH_AUDIENCE'] = 'aramo-recruiter-create-consent-default-spec';
    process.env['AUTH_PUBLIC_KEY'] = '-----BEGIN PUBLIC KEY-----\nMII\n-----END PUBLIC KEY-----';
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the token resolves to the adapter, and both create surfaces receive it', () => {
    if (module === undefined) throw new Error('AppModule did not compile');
    const bound = module.get(RECRUITER_CREATE_CONSENT_DEFAULT, { strict: false });
    expect(bound).toBeInstanceOf(RecruiterCreateConsentDefaultAdapter);
    const ctl = module.get(TalentRecordController, { strict: false }) as unknown as {
      recruiterCreateConsentDefault?: unknown;
      // TalentCreateFromDraftService is not barrel-exported; reach the injected
      // instance (shared by the draft-confirm + intake-promotion paths) via the
      // controller.
      createFromDraft?: { recruiterCreateConsentDefault?: unknown };
    };
    expect(ctl.recruiterCreateConsentDefault).toBe(bound);
    expect(ctl.createFromDraft).toBeDefined();
    expect(ctl.createFromDraft?.recruiterCreateConsentDefault).toBe(bound);
  });
});
