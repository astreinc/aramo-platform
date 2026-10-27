import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CognitoAdminService } from '../app/platform/cognito/cognito-admin.service.js';

// COG-ATTR-1 (LOCKED 2026-10-27) — AdminCreateUser sends the attribute set the `aramo-platform`
// pool requires (name / given_name / family_name / profile); the rest of the command is
// unchanged (Username, EMAIL delivery, SUPPRESS when asked). The SDK client is replaced by a stub.

type Sent = { input: { UserPoolId: string; Username: string; UserAttributes: { Name: string; Value: string }[]; DesiredDeliveryMediums: string[]; MessageAction?: string } };

describe('CognitoAdminService.adminCreateUser (COG-ATTR-1)', () => {
  const saved = process.env['AUTH_COGNITO_PLATFORM_USER_POOL_ID'];
  beforeEach(() => {
    process.env['AUTH_COGNITO_PLATFORM_USER_POOL_ID'] = 'us-east-1_platform';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['AUTH_COGNITO_PLATFORM_USER_POOL_ID'];
    else process.env['AUTH_COGNITO_PLATFORM_USER_POOL_ID'] = saved;
  });
  function serviceWith(send: ReturnType<typeof vi.fn>): CognitoAdminService {
    const svc = new CognitoAdminService();
    (svc as unknown as { client: { send: ReturnType<typeof vi.fn> } }).client = { send };
    return svc;
  }
  const created = { User: { Attributes: [{ Name: 'sub', Value: 'sub-1' }] } };

  it('COG-PA-1 sends email, name, given_name, family_name and profile, with EMAIL delivery and no MessageAction', async () => {
    const send = vi.fn().mockResolvedValue(created);
    await expect(serviceWith(send).adminCreateUser({ pool: 'platform', email: 'finance_admin@aramo.ai', display_name: 'Aramo Finance' })).resolves.toEqual({ cognito_sub: 'sub-1' });
    const cmd = send.mock.calls[0]![0] as Sent;
    expect(cmd.input).toEqual({
      UserPoolId: 'us-east-1_platform',
      Username: 'finance_admin@aramo.ai',
      UserAttributes: [
        { Name: 'email', Value: 'finance_admin@aramo.ai' },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: 'Aramo Finance' },
        { Name: 'given_name', Value: 'Aramo' },
        { Name: 'family_name', Value: 'Finance' },
        { Name: 'profile', Value: 'finance_admin@aramo.ai' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    });
  });

  it('COG-PA-2 no display name still sends every required attribute (the email local part); SUPPRESS is preserved', async () => {
    const send = vi.fn().mockResolvedValue(created);
    await serviceWith(send).adminCreateUser({ pool: 'platform', email: 'catalog_manager@aramo.ai', suppress: true });
    const cmd = send.mock.calls[0]![0] as Sent;
    const names = cmd.input.UserAttributes.map((a) => a.Name);
    expect(names).toEqual(['email', 'email_verified', 'name', 'given_name', 'family_name', 'profile']);
    expect(cmd.input.UserAttributes.every((a) => a.Value.length > 0)).toBe(true);
    expect(cmd.input.MessageAction).toBe('SUPPRESS');
  });
});
