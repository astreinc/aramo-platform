// Pure, testable logic for the e2e recruiter provisioning tool (Option B).
//
// This module holds NO Nest / AWS / DB imports — only the prod-guard, the
// arg parsing, and the provision orchestration over thin ports. The CLI
// (provision-e2e-recruiter.ts) boots the real Identity context and passes the
// real TenantUserLifecycleService + IdentityService as the ports. Keeping the
// logic here lets the spec prove the contract + the prod-guard without booting
// Nest. It is a new CALLER of inviteTenantUser — it reimplements NOTHING.

// The audit actor_id for the provisioning system actor. IdentityAuditEvent.
// actor_id is a nullable, NON-FK @db.Uuid column (verified in schema.prisma),
// so a stable sentinel is safe — it records "provisioned by the e2e tool".
export const SYSTEM_ACTOR_ID = '00000000-0000-7000-8000-0000000000e2';

const PROD_LIKE_ENVS = ['production', 'prod', 'staging', 'stage'];
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface GuardEnv {
  readonly ARAMO_ENV?: string;
  readonly DATABASE_URL?: string;
}

// SAFETY GUARD (mandatory): refuse to run unless BOTH (a) ARAMO_ENV is a
// non-prod value AND (b) DATABASE_URL points at a local host. This tool must
// never become a back-door around tenant:admin:user-manage in real ops.
export function assertNonProd(env: GuardEnv): void {
  const aramoEnv = (env.ARAMO_ENV ?? '').trim();
  if (aramoEnv === '') {
    throw new Error(
      'ARAMO_ENV is not set — refusing to provision (cannot confirm a non-prod target).',
    );
  }
  if (PROD_LIKE_ENVS.includes(aramoEnv.toLowerCase())) {
    throw new Error(
      `ARAMO_ENV='${aramoEnv}' is prod-like — refusing. This tool is local/dev only.`,
    );
  }
  const dbUrl = env.DATABASE_URL ?? '';
  if (dbUrl === '') {
    throw new Error('DATABASE_URL is not set — refusing (cannot confirm a local DB).');
  }
  let host: string;
  try {
    host = new URL(dbUrl).hostname;
  } catch {
    throw new Error('DATABASE_URL is unparseable — refusing (cannot confirm a local DB).');
  }
  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(
      `DATABASE_URL host '${host}' is not local — refusing. This tool provisions only against a local stack.`,
    );
  }
}

export interface ParsedArgs {
  readonly email: string;
  readonly tenant: string;
  readonly role: string;
  readonly actorUserId: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token !== undefined && token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, 'true');
      }
    }
  }
  const email = flags.get('email');
  const tenant = flags.get('tenant');
  if (email === undefined || email === '') {
    throw new Error('--email is required (e.g. --email recruiter-e2e@astreinc.test).');
  }
  if (tenant === undefined || tenant === '') {
    throw new Error('--tenant <TARGET_TENANT_ID> is required (PO-supplied).');
  }
  return {
    email,
    tenant,
    role: flags.get('role') ?? 'recruiter',
    actorUserId: flags.get('actor-user-id') ?? SYSTEM_ACTOR_ID,
  };
}

// --- ports (satisfied by the real services at the CLI; mocked in the spec) ---

export interface InviteTenantUserArgs {
  readonly tenant_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly role_keys: readonly string[];
  readonly actor_user_id: string;
  readonly request_id: string;
}

export interface InviteResultLike {
  readonly user: { readonly id: string };
  readonly membership_id: string;
  readonly cognito_sub: string;
}

export interface LifecyclePort {
  inviteTenantUser(args: InviteTenantUserArgs): Promise<InviteResultLike>;
}

export interface IdentityLookupPort {
  findUserByEmail(email: string): Promise<{ readonly id: string } | null>;
}

export interface ProvisionInput {
  readonly email: string;
  readonly tenantId: string;
  readonly role: string;
  readonly actorUserId: string;
  readonly requestId: string;
}

export type ProvisionResult =
  | {
      readonly status: 'created';
      readonly user_id: string;
      readonly membership_id: string;
      readonly cognito_sub: string;
      readonly tenant_id: string;
    }
  | { readonly status: 'already_exists'; readonly user_id: string; readonly tenant_id: string };

// Idempotent: if a User already exists for the email, report and DO NOT invite
// again (avoids a duplicate Cognito AdminCreateUser → UsernameExistsException).
// Otherwise run the REAL invite saga (Cognito create + DB tx, atomic w/ rollback).
export async function provisionRecruiter(
  ports: { readonly lifecycle: LifecyclePort; readonly identity: IdentityLookupPort },
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const existing = await ports.identity.findUserByEmail(input.email);
  if (existing !== null) {
    return {
      status: 'already_exists',
      user_id: existing.id,
      tenant_id: input.tenantId,
    };
  }
  const result = await ports.lifecycle.inviteTenantUser({
    tenant_id: input.tenantId,
    email: input.email,
    display_name: null,
    role_keys: [input.role],
    actor_user_id: input.actorUserId,
    request_id: input.requestId,
  });
  return {
    status: 'created',
    user_id: result.user.id,
    membership_id: result.membership_id,
    cognito_sub: result.cognito_sub,
    tenant_id: input.tenantId,
  };
}
