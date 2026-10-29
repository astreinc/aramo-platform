import { afterEach, describe, expect, it, vi } from 'vitest';
import { CognitoIdentityRetirement, NotConfiguredIdentityRetirement, identityRetirementFromEnv, type PrivacyRequestService } from '@aramo/identity';

import { SignPrivacyExecutionService } from '../app/privacy/sign-privacy-execution.service.js';
import { SignPrivacyExecutionWorker } from '../app/privacy/sign-privacy-execution.worker.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.2 "Execution is staged" — with
// SIGN_PRIVACY_DELETION_EXECUTION_ENABLED unset the worker never schedules, never
// reads the queue, and the execution service touches nothing.

const FLAG = 'SIGN_PRIVACY_DELETION_EXECUTION_ENABLED';

describe('privacy deletion execution — staged OFF by default (M-A7 §3.2)', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('the worker is not scheduled and a tick reads nothing', async () => {
    delete process.env[FLAG];
    const requests = { listExecuting: vi.fn() } as unknown as PrivacyRequestService;
    const execution = { execute: vi.fn() } as unknown as SignPrivacyExecutionService;
    const w = new SignPrivacyExecutionWorker(requests, execution);
    w.onApplicationBootstrap();
    expect(w.scheduled).toBe(false);
    expect(await w.tick()).toBe(0);
    expect(requests.listExecuting).not.toHaveBeenCalled();
    expect(execution.execute).not.toHaveBeenCalled();
  });

  it('execute() is skipped without reading or writing anything', async () => {
    for (const v of [undefined, '0', 'true', 'yes']) {
      if (v === undefined) delete process.env[FLAG];
      else process.env[FLAG] = v;
      const findById = vi.fn();
      const svc = new SignPrivacyExecutionService(
        { findById } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      expect(await svc.execute('r1')).toEqual({ status: 'skipped', reason: 'execution_disabled' });
      expect(findById).not.toHaveBeenCalled();
    }
  });

  it('the identity-owned retirement port is not configured without a tenant pool id (M-A8 §3.5)', async () => {
    expect(identityRetirementFromEnv({})).toBeInstanceOf(NotConfiguredIdentityRetirement);
    expect(await new NotConfiguredIdentityRetirement().retire()).toBe('not_configured');
    expect(identityRetirementFromEnv({ AUTH_COGNITO_TENANT_USER_POOL_ID: 'us-east-1_x' })).toBeInstanceOf(CognitoIdentityRetirement);
  });

  it('the Cognito retirement resolves the user by sub and deletes it — no global sign-out (M-A8 §3.5)', async () => {
    const sent: string[] = [];
    const send = vi.fn(async (c: { constructor: { name: string } }) => {
      sent.push(c.constructor.name);
      return c.constructor.name === 'ListUsersCommand' ? { Users: [{ Username: 'Google_1', Attributes: [{ Name: 'sub', Value: 's-1' }] }] } : {};
    });
    expect(await new CognitoIdentityRetirement('pool', { send } as never).retire({ cognito_sub: 's-1' })).toBe('deleted');
    expect(sent).toEqual(['ListUsersCommand', 'AdminDeleteUserCommand']);
    const broken = new CognitoIdentityRetirement('pool', { send: vi.fn(async () => Promise.reject(new Error('denied'))) } as never);
    expect(await broken.retire({ cognito_sub: 's-1' })).toBe('failed');
  });
});
