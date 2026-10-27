import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AramoError, AramoExceptionFilter } from '@aramo/common';
import { DOCUMENT_SOURCE_PROVIDER_PORT, EsignService, SignatureFieldIncompleteError, SignatureFieldValueRefusedError } from '@aramo/sign';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EsignProviderController, toHttp } from '../app/esign-http.controller.js';
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

// M-A6 §2 — signer field refusals carry a stable details.reason at the HTTP boundary.
describe('toHttp — Name and Checkbox refusals (M-A6 §2)', () => {
  it('maps a refused fill value to 400 VALIDATION_ERROR and a broken completion rule to 409 with its reason', () => {
    const refused = toHttp(new SignatureFieldValueRefusedError('f1', 'signer_profile_name_server_filled'), 'r1');
    expect(refused).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400, context: { details: { reason: 'signer_profile_name_server_filled', field_id: 'f1' } } });
    const group = toHttp(new SignatureFieldIncompleteError('s1', 'checkbox_group_select_one', 'plan'), 'r1');
    expect(group).toMatchObject({ code: 'SIGNATURE_FIELD_INCOMPLETE', statusCode: 409, context: { details: { reason: 'checkbox_group_select_one', group_key: 'plan' } } });
    const legacy = toHttp(new SignatureFieldIncompleteError('s1'), 'r1');
    expect(legacy).toMatchObject({ code: 'SIGNATURE_FIELD_INCOMPLETE', context: { details: { reason: 'required_field_unfilled' } } });
  });
});
