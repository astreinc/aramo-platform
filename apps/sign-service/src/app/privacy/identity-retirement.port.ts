import { Logger } from '@nestjs/common';
import { AdminDeleteUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient, UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.2 "Shared identity" — retiring the sign-in
// identity of a deleted Personal account. The execution service calls this ONLY after
// the shared-identity guard found no other membership or product authorization.
//
//   cognito    AdminUserGlobalSignOut + AdminDeleteUser in the tenant user pool
//              (AUTH_COGNITO_TENANT_USER_POOL_ID; the same pool and username — the
//              email — the platform's Cognito admin adapters use).
//   none       no pool configured: nothing is called; the outcome records that the
//              Aramo privacy team completes the IdP step (the Aramo user is already
//              deactivated, so sign-in is refused either way).
// The outcome is a code, never the identity itself.

export const IDENTITY_RETIREMENT_PORT = 'SIGN_PRIVACY_IDENTITY_RETIREMENT_PORT';

export type IdentityRetirementOutcome = 'deleted' | 'not_found' | 'not_configured' | 'failed';

export interface IdentityRetirementPort {
  retire(input: { email: string }): Promise<IdentityRetirementOutcome>;
}

export class NotConfiguredIdentityRetirement implements IdentityRetirementPort {
  async retire(): Promise<IdentityRetirementOutcome> {
    return 'not_configured';
  }
}

export class CognitoIdentityRetirement implements IdentityRetirementPort {
  private readonly log = new Logger('IdentityRetirement');
  constructor(
    private readonly userPoolId: string,
    private readonly client: Pick<CognitoIdentityProviderClient, 'send'> = new CognitoIdentityProviderClient({
      region: process.env['AWS_REGION'] ?? 'us-east-1',
      ...(process.env['AUTH_COGNITO_ENDPOINT'] !== undefined ? { endpoint: process.env['AUTH_COGNITO_ENDPOINT'] } : {}),
    }),
  ) {}

  async retire(input: { email: string }): Promise<IdentityRetirementOutcome> {
    try {
      await this.client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: input.email }));
      await this.client.send(new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: input.email }));
      return 'deleted';
    } catch (err) {
      if (err instanceof UserNotFoundException || (err as { name?: string }).name === 'UserNotFoundException') return 'not_found';
      this.log.warn(`identity retirement failed: ${(err as Error).name}`);
      return 'failed';
    }
  }
}

export function identityRetirementFromEnv(env: NodeJS.ProcessEnv = process.env): IdentityRetirementPort {
  const pool = env['AUTH_COGNITO_TENANT_USER_POOL_ID'];
  return pool !== undefined && pool.trim() !== '' ? new CognitoIdentityRetirement(pool.trim()) : new NotConfiguredIdentityRetirement();
}
