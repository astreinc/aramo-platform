import { Controller, Get, type INestApplication, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  NATIVE_CALLBACK_FALLBACK_PAGE,
  NATIVE_SIGNED_OUT_PAGE,
  NativeAuthPagesController,
} from '../lib/native-auth.controller.js';

// Stand-in for AuthController's GET /auth/:consumer/callback, the route that
// would otherwise take /auth/native/callback.
@Controller('auth')
class ConsumerCallbackStub {
  @Get(':consumer/callback')
  callback(@Param('consumer') consumer: string): { consumer: string } {
    return { consumer };
  }
}

const SECRET_CODE = 'code-0f9e8d7c6b5a';
const SECRET_STATE = 'state-1a2b3c4d5e6f';
const HOSTILE = 'https://evil.example/steal';

describe('NativeAuthPagesController (M-A1 §6 browser fallback pages)', () => {
  let app: INestApplication | undefined;

  async function boot(controllers: Array<new (...args: never[]) => unknown>): Promise<INestApplication> {
    const module = await Test.createTestingModule({ controllers }).compile();
    app = module.createNestApplication();
    await app.init();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  for (const [path, page, heading] of [
    ['/auth/native/callback', NATIVE_CALLBACK_FALLBACK_PAGE, 'Finish signing in in the app'],
    ['/auth/native/signed-out', NATIVE_SIGNED_OUT_PAGE, 'You are signed out'],
  ] as const) {
    it(`${path}: a fixed, uncached, script-free page that echoes nothing from the request`, async () => {
      const a = await boot([NativeAuthPagesController, ConsumerCallbackStub]);
      const res = await request(a.getHttpServer())
        .get(path)
        .query({ code: SECRET_CODE, state: SECRET_STATE, redirect_uri: HOSTILE, logout_uri: HOSTILE, next: HOSTILE })
        .set('Referer', HOSTILE);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['location']).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();

      // Exactly the constant page: nothing from the query, header or path.
      expect(res.text).toBe(page);
      expect(res.text).toContain(heading);
      for (const leaked of [SECRET_CODE, SECRET_STATE, 'evil.example']) expect(res.text).not.toContain(leaked);
      expect(res.text).not.toMatch(/<script|http-equiv/i);
      // The only link is the fixed app address.
      expect([...res.text.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(['aramosign://']);
    });
  }

  it('wins over GET /auth/:consumer/callback only when registered first (the auth-service module order)', async () => {
    const first = await boot([NativeAuthPagesController, ConsumerCallbackStub]);
    expect((await request(first.getHttpServer()).get('/auth/native/callback')).text).toBe(NATIVE_CALLBACK_FALLBACK_PAGE);
    expect((await request(first.getHttpServer()).get('/auth/sign/callback')).body).toEqual({ consumer: 'sign' });
    await first.close();

    const after = await boot([ConsumerCallbackStub, NativeAuthPagesController]);
    expect((await request(after.getHttpServer()).get('/auth/native/callback')).body).toEqual({ consumer: 'native' });
  });
});
