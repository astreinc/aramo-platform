import { Injectable, Logger } from '@nestjs/common';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

// CognitoAdminService — wraps the AWS SDK Cognito-IDP admin operations
// (Lead ruling 1: Pattern A — Cognito-first AdminCreateUser; Aramo
// stores no password, Cognito owns the credential + the temp-password
// invitation email).
//
// Pool routing (Lead ruling 4 A1 — SEPARATE pools for platform vs
// tenant): the service accepts a `pool` parameter ('tenant' | 'platform')
// and resolves the UserPoolId from the matching env var. The auth-service
// reads the SAME env names on the verifier side so the JWT-issuance and
// the AdminCreateUser path agree on which pool a given consumer_type
// uses.
//
// IAM (readiness-track): the deploy role must hold
//   cognito-idp:AdminCreateUser
//   cognito-idp:AdminDeleteUser  (rollback when identity-tx fails)
//   cognito-idp:AdminGetUser     (idempotency check for re-invite)
// on BOTH pools. Flagged in the AUTHZ-2 commit plan readiness carries.
export type CognitoPool = 'tenant' | 'platform';

export interface AdminCreateUserResult {
  cognito_sub: string;
}

@Injectable()
export class CognitoAdminService {
  private readonly logger = new Logger(CognitoAdminService.name);
  private readonly client: CognitoIdentityProviderClient;

  constructor() {
    const region = process.env['AWS_REGION'] ?? 'us-east-1';
    // LocalStack opt-in: the Gate-6 proofs use LocalStack to mock the
    // Cognito-IDP admin operations (the live Cognito wiring is a
    // readiness-track concern). When AUTH_COGNITO_ENDPOINT is set, the
    // SDK client routes there; otherwise it talks to AWS.
    const endpoint = process.env['AUTH_COGNITO_ENDPOINT'];
    this.client = new CognitoIdentityProviderClient({
      region,
      ...(endpoint !== undefined ? { endpoint } : {}),
    });
  }

  private userPoolIdForPool(pool: CognitoPool): string {
    const env =
      pool === 'platform'
        ? 'AUTH_COGNITO_PLATFORM_USER_POOL_ID'
        : 'AUTH_COGNITO_TENANT_USER_POOL_ID';
    const value = process.env[env];
    if (value === undefined || value.length === 0) {
      throw new Error(`${env} is not configured`);
    }
    return value;
  }

  // Pattern A — Cognito-first invitation. AdminCreateUser instructs Cognito
  // to send the invitation email + provision a temp password; the returned
  // `Username` field is the Cognito `sub` (UUID) we mirror to identity DB
  // via ExternalIdentity (provider='cognito', provider_subject=sub).
  // DesiredDeliveryMediums=['EMAIL'] is the medium for the temp-password
  // delivery; the email is verified (email_verified=true) since the
  // platform-admin owns the invite and trusts the recipient.
  //
  // Inc-3 PR-3.4 (R16, create-now-invite-later): `suppress` sets
  // MessageAction='SUPPRESS' — Cognito still creates the user in
  // FORCE_CHANGE_PASSWORD (temp password minted) but sends NO invitation
  // email. A later adminResendInvite (MessageAction='RESEND') delivers the
  // invite AND resets the temp-password duration with a fresh password, so the
  // send-when-ready path works even after the original temp password would have
  // expired. Omitted/false → today's send-on-create behavior (byte-preserved).
  async adminCreateUser(args: {
    pool: CognitoPool;
    email: string;
    display_name?: string | null;
    suppress?: boolean;
  }): Promise<AdminCreateUserResult> {
    const UserPoolId = this.userPoolIdForPool(args.pool);
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
        ...(args.suppress === true ? { MessageAction: 'SUPPRESS' as const } : {}),
      }),
    );
    const sub = out.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
    if (sub === undefined || sub.length === 0) {
      // Cognito returned a 2xx but the response did not carry the `sub`
      // attribute. Treat as upstream failure so the saga compensates
      // (the identity-tx has not yet committed at this point).
      throw new Error('cognito_admin_create_user_missing_sub');
    }
    return { cognito_sub: sub };
  }

  // Platform-Console Increment-2 PR-1.5 (A2) — re-send the owner's Cognito
  // invitation. AdminCreateUser with MessageAction='RESEND' re-delivers the
  // temp-password invitation email to an EXISTING user who has NOT yet set a
  // password (Cognito status FORCE_CHANGE_PASSWORD). It does NOT create a new
  // user and does NOT reset an already-CONFIRMED user — Cognito rejects RESEND
  // for a confirmed account. The caller gates on tenant status PROVISIONED,
  // which is exactly the window in which the owner is still unconfirmed, so
  // RESEND is always valid on this path (see resendOwnerInvite).
  async adminResendInvite(args: {
    pool: CognitoPool;
    email: string;
    display_name?: string | null;
  }): Promise<void> {
    const UserPoolId = this.userPoolIdForPool(args.pool);
    const userAttributes: Array<{ Name: string; Value: string }> = [
      { Name: 'email', Value: args.email },
      { Name: 'email_verified', Value: 'true' },
    ];
    if (args.display_name !== undefined && args.display_name !== null) {
      userAttributes.push({ Name: 'name', Value: args.display_name });
    }
    await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username: args.email,
        UserAttributes: userAttributes,
        DesiredDeliveryMediums: ['EMAIL'],
        MessageAction: 'RESEND',
      }),
    );
  }

  async adminGetUser(args: {
    pool: CognitoPool;
    email: string;
  }): Promise<{ cognito_sub: string } | null> {
    const UserPoolId = this.userPoolIdForPool(args.pool);
    try {
      const out = await this.client.send(
        new AdminGetUserCommand({ UserPoolId, Username: args.email }),
      );
      const sub = out.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
      if (sub === undefined || sub.length === 0) return null;
      return { cognito_sub: sub };
    } catch (err) {
      if (err instanceof UserNotFoundException) return null;
      throw err;
    }
  }

  // Lead ruling 7 compensation: invoked when the identity-tx fails after
  // Cognito returned a `sub`. Idempotent — UserNotFoundException is
  // swallowed so re-execution of the rollback path is safe.
  async adminDeleteUser(args: {
    pool: CognitoPool;
    email: string;
  }): Promise<void> {
    const UserPoolId = this.userPoolIdForPool(args.pool);
    try {
      await this.client.send(
        new AdminDeleteUserCommand({ UserPoolId, Username: args.email }),
      );
    } catch (err) {
      if (err instanceof UserNotFoundException) {
        return;
      }
      this.logger.warn(
        `cognito admin delete user failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
