import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AramoError, AramoExceptionFilter } from '@aramo/common';
import { DOCUMENT_SOURCE_PROVIDER_PORT, EsignService } from '@aramo/sign';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EsignProviderController } from '../app/esign-http.controller.js';
import { NativeAramoSignatureProvider } from '../app/native-aramo-signature.provider.js';

// The internal envelopes zone returns the canonical error envelope, so an allowance
// refusal reaches the ATS adapter with its code and details instead of a bare 500.
describe('EsignProviderController — typed refusals over HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const provider = {
      sendEnvelope: async () => {
        throw new AramoError('ESIGN_ALLOWANCE_EXHAUSTED', 'used up', 409, {
          requestId: '',
          details: { reason: 'LIMIT_REACHED', limit: 100, used: 100, period_end: '2026-11-01T00:00:00.000Z' },
        });
      },
    };
    const mod = await Test.createTestingModule({
      controllers: [EsignProviderController],
      providers: [
        { provide: NativeAramoSignatureProvider, useValue: provider },
        { provide: EsignService, useValue: {} },
        { provide: DOCUMENT_SOURCE_PROVIDER_PORT, useValue: {} },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('mounts the canonical filter', () => {
    expect(Reflect.getMetadata('__exceptionFilters__', EsignProviderController)).toContain(AramoExceptionFilter);
  });

  it('a send refused for the allowance returns 409 with the reason and limit', async () => {
    const res = await request(app.getHttpServer()).post('/v1/sign/envelopes/env-1/send').send({ tenant_id: '0190aaaa-0000-7000-8000-000000000001' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'ESIGN_ALLOWANCE_EXHAUSTED', details: { reason: 'LIMIT_REACHED', limit: 100 } });
  });
});
