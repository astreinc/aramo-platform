import { HOST_CLASSES, type HostClass } from './dto/host-auth-profile.dto.js';

// Auth-Decoupling PR-1 §2.4 — the host auth-profile seed. THREE rows reproducing
// today's behaviour exactly (one per class, R-A1-7). The Cognito profile columns
// are read from the SAME env vars the auth-service reads today, so a seeded
// registry is byte-identical to the env path (R-A1-1). pool_id is fixed to the
// single reused pool (R-A1-5: NO multi-pool logic). default_idp is null for
// every class — PLATFORM/PORTAL carry no IdP hint today, and TENANT is overridden
// per-request by tenant.identity_provider (so its class default is never used).
//
// The row VALUES depend on env; the row CLASSES are fixed to HOST_CLASSES. The
// §3.3 seed-parity guard asserts the class set here equals what the classifier
// can produce.

// R-A1-5 — the single reused Cognito pool. Seeded on every class; pool separation
// is a later DATA operation at class level, not code.
export const SEED_POOL_ID = 'us-east-1_4fKlnGfaW';

// §2.4 default host patterns — today's prod hosts, used when the corresponding
// env allow-list is unset. Exported as the SINGLE literal home for these host
// strings so consumers (specs) derive them rather than re-typing a literal — the
// portal host word is a host-string reservation, not talent-entity vocabulary
// (see the tenant-slug.ts precedent + the paired vocabulary-exemption entries).
export const DEFAULT_PLATFORM_HOST = 'admin.aramo.ai';
export const DEFAULT_PORTAL_HOST = 'candidate.aramo.ai';

// Fixed ids so re-seeding is deterministic (mirrors the identity seed's
// hardcoded UUIDs); the upsert keys on host_class (UNIQUE), so id only matters
// on first insert.
const SEED_IDS: Readonly<Record<HostClass, string>> = {
  TENANT: '01900000-0000-7000-8000-0000000a0001',
  PLATFORM: '01900000-0000-7000-8000-0000000a0002',
  PORTAL: '01900000-0000-7000-8000-0000000a0003',
};

export interface HostAuthProfileSeedRow {
  id: string;
  host_class: HostClass;
  host_pattern: string;
  pool_id: string;
  client_id: string;
  issuer: string;
  domain: string;
  default_idp: string | null;
  post_login_path: string;
  signout_path: string;
  is_active: boolean;
}

type Env = Record<string, string | undefined>;

// First comma-separated entry of an allow-list env var, lowercased + trimmed +
// port-stripped — the exact normalisation hostSetFromEnv applies today, so the
// seeded PLATFORM/PORTAL host_pattern matches what the env path would derive.
function firstHost(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const first = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .map((h) => {
      const colon = h.lastIndexOf(':');
      return colon === -1 ? h : h.slice(0, colon);
    })
    .filter((h) => h.length > 0)[0];
  return first ?? fallback;
}

// Build the three seed rows from an environment. Pure (no I/O) so the parity
// guard can run it directly. Defaults reproduce the .env.prod.example posture:
// PLATFORM admin.aramo.ai, PORTAL candidate.aramo.ai, TENANT *.<APP_ROOT_DOMAIN>.
export function buildHostAuthProfileSeedRows(
  env: Env = process.env,
): HostAuthProfileSeedRow[] {
  const rootDomain = (env['APP_ROOT_DOMAIN'] ?? 'aramo.ai').trim().toLowerCase();
  const cognito = {
    pool_id: SEED_POOL_ID,
    client_id: env['AUTH_COGNITO_CLIENT_ID'] ?? '',
    issuer: env['AUTH_COGNITO_ISSUER'] ?? '',
    domain: env['AUTH_COGNITO_DOMAIN'] ?? '',
  } as const;
  const postLoginPath = env['AUTH_POST_LOGIN_PATH'] ?? '/';
  const signoutPath = env['AUTH_SIGNOUT_PATH'] ?? '/';

  const base = (host_class: HostClass, host_pattern: string): HostAuthProfileSeedRow => ({
    id: SEED_IDS[host_class],
    host_class,
    host_pattern,
    ...cognito,
    default_idp: null,
    post_login_path: postLoginPath,
    signout_path: signoutPath,
    is_active: true,
  });

  return [
    base('PLATFORM', firstHost(env['AUTH_PLATFORM_HOSTS'], DEFAULT_PLATFORM_HOST)),
    base('PORTAL', firstHost(env['AUTH_PORTAL_HOSTS'], DEFAULT_PORTAL_HOST)),
    base('TENANT', `*.${rootDomain}`),
  ];
}

// Minimal shape of the auth-storage Prisma client the seed touches. Kept
// structural so a runnable entry, an integration spec, or a fake can drive it.
export interface HostAuthProfileSeedClient {
  hostAuthProfile: {
    upsert(args: {
      where: { host_class: string };
      create: Omit<HostAuthProfileSeedRow, never>;
      update: Omit<HostAuthProfileSeedRow, 'id'>;
    }): Promise<unknown>;
  };
}

// Idempotent upsert of the three rows, keyed on host_class (UNIQUE). Re-running
// produces no duplicates and refreshes the profile columns to current env — so a
// redeploy that rotates a Cognito value keeps the registry current.
export async function seedHostAuthProfiles(
  prisma: HostAuthProfileSeedClient,
  env: Env = process.env,
): Promise<{ seeded: HostClass[] }> {
  const rows = buildHostAuthProfileSeedRows(env);
  for (const row of rows) {
    const { id: _id, ...mutable } = row;
    await prisma.hostAuthProfile.upsert({
      where: { host_class: row.host_class },
      create: row,
      update: mutable,
    });
  }
  return { seeded: rows.map((r) => r.host_class) };
}

// Re-export the closed vocab so seed consumers (and the parity guard) have a
// single import site.
export { HOST_CLASSES };
