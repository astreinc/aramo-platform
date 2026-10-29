import { Logger } from '@nestjs/common';
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  UserNotFoundException,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';

// Aramo-Sign-Mobile-Amendment-M-A8 §3.5 — identity-service authority over the
// retirement of a Personal account's sign-in identity. The port is identity-owned
// (it replaces the sign-service adapter that deleted by email); there is exactly one
// AWS adapter:
//
//   lookup({ cognito_sub, email })  the pool user found BY `sub` (ListUsers filter),
//                                   its `identities` attribute (federated providers
//                                   linked to it) and any OTHER pool user with the
//                                   same email. Feeds dependency (e) of the
//                                   IdentityDependencyInspector.
//   retire({ cognito_sub })         resolves the pool username BY `sub`, then
//                                   AdminDeleteUser on that username in the tenant
//                                   pool. A federated (Google / Microsoft) pool user
//                                   is deleted only as the Cognito profile — the
//                                   external account is never touched (Cognito
//                                   cannot delete it).
//
// AdminUserGlobalSignOut is NOT used and NOT granted (§3.5): Aramo sessions are already
// revoked and the user deactivated, and deleting the pool user ends Cognito refresh.
// Pool: AUTH_COGNITO_TENANT_USER_POOL_ID; unset → `not_configured` (nothing is called).
// Outcomes are codes, never the identity itself.

export const IDENTITY_RETIREMENT_PORT = 'IDENTITY_RETIREMENT_PORT';

export type IdentityRetirementOutcome = 'deleted' | 'not_found' | 'not_configured' | 'failed';

export type IdentityPoolLookup =
  | { status: 'not_configured' }
  | { status: 'failed' }
  | {
      status: 'ok';
      /** A pool user exists with this `sub`. */
      subject_found: boolean;
      /** Federated providers in that user's `identities` attribute OTHER than the user's own federation. */
      linked_providers: number;
      /** Pool users with the same email whose `sub` is not this subject. */
      other_users_same_email: number;
    };

export interface IdentityRetirementPort {
  lookup(input: { cognito_sub: string | null; email?: string | null }): Promise<IdentityPoolLookup>;
  retire(input: { cognito_sub: string }): Promise<IdentityRetirementOutcome>;
}

export class NotConfiguredIdentityRetirement implements IdentityRetirementPort {
  async lookup(): Promise<IdentityPoolLookup> {
    return { status: 'not_configured' };
  }
  async retire(): Promise<IdentityRetirementOutcome> {
    return 'not_configured';
  }
}

/** A Cognito ListUsers filter value: backslash and double quote escaped. */
export function cognitoFilterValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const attr = (u: UserType, name: string): string | undefined => u.Attributes?.find((a) => a.Name === name)?.Value;

/**
 * Entries of the `identities` attribute that are NOT the pool user's own federation.
 * A federated pool user is named `<providerName>_<userId>`; its own entry is that pair.
 * Any other entry is a Cognito-level link (e.g. a Google user linked into this one).
 */
export function linkedProviderCount(u: UserType): number {
  const raw = attr(u, 'identities');
  if (raw === undefined || raw.trim() === '') return 0;
  let entries: Array<{ providerName?: string; userId?: string }>;
  try {
    const parsed: unknown = JSON.parse(raw);
    entries = Array.isArray(parsed) ? (parsed as Array<{ providerName?: string; userId?: string }>) : [];
  } catch {
    // Unreadable attribute: count it as a link (fail closed — the identity is kept).
    return 1;
  }
  const own = (u.Username ?? '').toLowerCase();
  return entries.filter((e) => `${e.providerName ?? ''}_${e.userId ?? ''}`.toLowerCase() !== own).length;
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

  private async listUsers(filter: string): Promise<UserType[]> {
    const out: UserType[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListUsersCommand({ UserPoolId: this.userPoolId, Filter: filter, Limit: 60, ...(token !== undefined ? { PaginationToken: token } : {}) }));
      out.push(...(res.Users ?? []));
      token = res.PaginationToken;
    } while (token !== undefined && token !== '');
    return out;
  }

  private async bySub(sub: string): Promise<UserType | null> {
    return (await this.listUsers(`sub = "${cognitoFilterValue(sub)}"`))[0] ?? null;
  }

  async lookup(input: { cognito_sub: string | null; email?: string | null }): Promise<IdentityPoolLookup> {
    try {
      const user = input.cognito_sub !== null ? await this.bySub(input.cognito_sub) : null;
      const email = (user !== null ? attr(user, 'email') : undefined) ?? input.email ?? null;
      const sameEmail = email !== null && email.trim() !== '' ? await this.listUsers(`email = "${cognitoFilterValue(email.trim())}"`) : [];
      return {
        status: 'ok',
        subject_found: user !== null,
        linked_providers: user !== null ? linkedProviderCount(user) : 0,
        other_users_same_email: sameEmail.filter((u) => input.cognito_sub === null || attr(u, 'sub') !== input.cognito_sub).length,
      };
    } catch (err) {
      this.log.warn(`identity pool lookup failed: ${(err as Error).name}`);
      return { status: 'failed' };
    }
  }

  async retire(input: { cognito_sub: string }): Promise<IdentityRetirementOutcome> {
    try {
      const user = await this.bySub(input.cognito_sub);
      if (user === null || user.Username === undefined) return 'not_found';
      await this.client.send(new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: user.Username }));
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
