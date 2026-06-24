import { Injectable, Logger } from '@nestjs/common';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import type { TenantCognitoPort } from '@aramo/identity';

// Settings S3a — TenantCognitoAdapter (live AWS-SDK implementation of
// the TENANT_COGNITO_PORT declared in libs/identity).
//
// The tenant-tier counterpart to apps/platform-admin's CognitoAdminService.
// Same SDK + same Cognito conventions; tenant pool only (the platform pool
// is the platform-admin service's concern). The pool id is the
// AUTH_COGNITO_TENANT_USER_POOL_ID env var — the SAME var the platform-
// admin service reads when its `pool` argument is 'tenant', so both code
// paths agree on which user pool serves tenant invitees.
//
// LocalStack opt-in mirrors the platform-admin service: when
// AUTH_COGNITO_ENDPOINT is set, the SDK client routes there. CI uses
// mocks (the AUTHZ-2 posture); live wiring is a readiness carry.
//
// IAM (readiness-track): the deploy role must hold
//   cognito-idp:AdminCreateUser
//   cognito-idp:AdminDeleteUser     (invite-saga rollback)
//   cognito-idp:AdminDisableUser    (disable-saga step 2)
//   cognito-idp:AdminEnableUser     (out-of-S3a scope; declared for symmetry)
// on the TENANT pool. Flagged with the AUTHZ-2 carry.
@Injectable()
export class TenantCognitoAdapter implements TenantCognitoPort {
  private readonly logger = new Logger(TenantCognitoAdapter.name);
  private readonly client: CognitoIdentityProviderClient;

  constructor() {
    const region = process.env['AWS_REGION'] ?? 'us-east-1';
    const endpoint = process.env['AUTH_COGNITO_ENDPOINT'];
    this.client = new CognitoIdentityProviderClient({
      region,
      ...(endpoint !== undefined ? { endpoint } : {}),
    });
  }

  private userPoolId(): string {
    const value = process.env['AUTH_COGNITO_TENANT_USER_POOL_ID'];
    if (value === undefined || value.length === 0) {
      throw new Error('AUTH_COGNITO_TENANT_USER_POOL_ID is not configured');
    }
    return value;
  }

  // Invite-S2 (Pattern-2): RETAINED for the backlogged native-account invite
  // path; NOT called by the Pattern-2 federated invite flow (which mints no
  // Cognito user at invite time — the sub links at first federated login via
  // the reconcile spine). Kept fully implemented, mirroring adminEnableUser's
  // "declared, not currently called" posture. The TENANT_COGNITO_PORT binding
  // (forRoot + the IdentityModule-split fix) STAYS — adminDisableUser /
  // adminEnableUser still serve the live disable/enable lifecycle ops.
  async adminCreateUser(args: {
    email: string;
    display_name?: string | null;
  }): Promise<{ cognito_sub: string }> {
    const UserPoolId = this.userPoolId();
    const userAttributes: Array<{ Name: string; Value: string }> = [
      { Name: 'email', Value: args.email },
      { Name: 'email_verified', Value: 'true' },
    ];
    if (args.display_name !== undefined && args.display_name !== null) {
      userAttributes.push({ Name: 'name', Value: args.display_name });
    }
    const out = await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username: args.email,
        UserAttributes: userAttributes,
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
    const sub = out.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
    if (sub === undefined || sub.length === 0) {
      throw new Error('cognito_admin_create_user_missing_sub');
    }
    return { cognito_sub: sub };
  }

  // Idempotent: UserNotFoundException is swallowed so the invite-saga's
  // compensation is safe to re-run.
  async adminDeleteUser(args: { email: string }): Promise<void> {
    const UserPoolId = this.userPoolId();
    try {
      await this.client.send(
        new AdminDeleteUserCommand({ UserPoolId, Username: args.email }),
      );
    } catch (err) {
      if (err instanceof UserNotFoundException) return;
      this.logger.warn(
        `cognito admin delete user failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async adminDisableUser(args: { email: string }): Promise<void> {
    const UserPoolId = this.userPoolId();
    await this.client.send(
      new AdminDisableUserCommand({ UserPoolId, Username: args.email }),
    );
  }

  async adminEnableUser(args: { email: string }): Promise<void> {
    const UserPoolId = this.userPoolId();
    await this.client.send(
      new AdminEnableUserCommand({ UserPoolId, Username: args.email }),
    );
  }
}
