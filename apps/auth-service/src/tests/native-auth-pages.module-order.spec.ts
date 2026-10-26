import 'reflect-metadata';

import { AuthController, NativeAuthPagesController } from '@aramo/auth-core';
import { describe, expect, it } from 'vitest';

import { AuthServiceModule } from '../app/auth/auth.module.js';

// GET /auth/native/callback must reach NativeAuthPagesController, not
// AuthController's GET /auth/:consumer/callback. Express matches routes in
// registration order, and Nest registers controllers in array order, so the
// pages controller has to come first in the real module.
describe('auth-service AuthServiceModule controller order', () => {
  it('registers NativeAuthPagesController before AuthController', () => {
    const controllers = Reflect.getMetadata('controllers', AuthServiceModule) as unknown[];
    const pages = controllers.indexOf(NativeAuthPagesController);
    const auth = controllers.indexOf(AuthController);
    expect(pages).toBeGreaterThanOrEqual(0);
    expect(auth).toBeGreaterThan(pages);
  });
});
