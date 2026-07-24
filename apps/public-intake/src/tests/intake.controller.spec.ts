import 'reflect-metadata';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { IntakeExceptionFilter } from '../app/intake/intake-exception.filter.js';
import { IntakeModule } from '../app/intake/intake.module.js';
import { INTAKE_SES_CLIENT } from '../app/intake/tokens.js';

// §1.10 — validation happy/refusal, honeypot silent-drop, healthz, and the
// island (JSON) vs no-JS (HTML 303) response semantics. SES is mocked via the
// INTAKE_SES_CLIENT token — no AWS. A generous rate limit avoids cross-test
// bucket interference (the trip/reset itself is covered in the service spec).
describe('IntakeController', () => {
  let app: INestApplication;
  const send = vi.fn().mockResolvedValue({});

  beforeAll(async () => {
    process.env['INTAKE_RATE_LIMIT_PER_HOUR'] = '1000';
    const moduleRef = await Test.createTestingModule({
      imports: [IntakeModule],
    })
      .overrideProvider(INTAKE_SES_CLIENT)
      .useValue({ send })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        errorHttpStatusCode: 422,
      }),
    );
    app.useGlobalFilters(new IntakeExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env['INTAKE_RATE_LIMIT_PER_HOUR'];
  });

  it('GET /intake/healthz → 200', async () => {
    await request(app.getHttpServer()).get('/intake/healthz').expect(200);
  });

  it('valid workspace request → 200 { ok: true } (JSON island) and sends', async () => {
    send.mockClear();
    const res = await request(app.getHttpServer())
      .post('/intake/workspace-request')
      .set('Accept', 'application/json')
      .send({ name: 'Ada', email: 'ada@firm.example', firm: 'Firm Co' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it('missing required field → 422 (JSON)', async () => {
    const res = await request(app.getHttpServer())
      .post('/intake/workspace-request')
      .set('Accept', 'application/json')
      .send({ name: 'Ada' });
    expect(res.status).toBe(422);
  });

  it('over-cap field → 422 (JSON)', async () => {
    const res = await request(app.getHttpServer())
      .post('/intake/contact')
      .set('Accept', 'application/json')
      .send({ name: 'A'.repeat(201), email: 'a@b.com', message: 'hi' });
    expect(res.status).toBe(422);
  });

  it('honeypot filled → 204 silent drop, no send', async () => {
    send.mockClear();
    const res = await request(app.getHttpServer())
      .post('/intake/contact')
      .set('Accept', 'application/json')
      .send({
        name: 'Bot',
        email: 'bot@spam.example',
        message: 'spam',
        website: 'http://spam.example',
      });
    expect(res.status).toBe(204);
    expect(send).not.toHaveBeenCalled();
  });

  it('no-JS HTML form post → 303 redirect to /thanks', async () => {
    send.mockClear();
    const res = await request(app.getHttpServer())
      .post('/intake/contact')
      .set('Accept', 'text/html')
      .type('form')
      .send({ name: 'Cy', email: 'cy@example.com', message: 'hi' });
    expect(res.status).toBe(303);
    expect(res.headers['location']).toContain('/thanks');
    expect(send).toHaveBeenCalledOnce();
  });

  it('no-JS HTML validation failure → 303 to /thanks?err=1', async () => {
    const res = await request(app.getHttpServer())
      .post('/intake/contact')
      .set('Accept', 'text/html')
      .type('form')
      .send({ name: 'Cy' });
    expect(res.status).toBe(303);
    expect(res.headers['location']).toContain('/thanks?err=1');
  });
});
