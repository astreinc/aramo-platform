import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommunicationsPrismaService, CommunicationsRepository } from '@aramo/communications';
import {
  DelegatedAuthorizationService,
  MicrosoftConsentRevokedError,
  MicrosoftOAuthStateError,
  MicrosoftReauthRequiredError,
  decryptMicrosoftOAuthState,
  type MicrosoftTokenExchangeResult,
} from '@aramo/microsoft-graph';
import type {
  SecretsManagerPort,
  SecretsManagerWriterPort,
} from '@aramo/integration';

import { DelegatedTokenSecretStoreAdapter } from '../microsoft/delegated-token-secret-store.adapter.js';
import { ProviderIdentityStoreAdapter } from '../microsoft/provider-identity-store.adapter.js';

// COMM-C2B §4 — real-Postgres security proofs for the delegated-authorization
// substrate. Exercises the REAL persistence adapter (CommunicationProviderIdentity
// on PG 17) + the REAL secret-store custody adapter (over an in-memory Secrets
// Manager fake) + the provider-neutral DelegatedAuthorizationService with a fake
// Microsoft token endpoint. Proves: token custody is secret-store-only, no token
// touches PG, recruiter/tenant isolation, callback state rejection, and
// revoked-refresh → reauthorization-required. Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');

function communicationsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/communications/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

// In-memory Secrets Manager — the only place a token bundle may live.
class FakeSecrets implements SecretsManagerWriterPort, SecretsManagerPort {
  readonly map = new Map<string, string>();
  async putSecretValue(id: string, value: string): Promise<void> {
    this.map.set(id, value);
  }
  async getSecretValue(id: string): Promise<string> {
    const v = this.map.get(id);
    if (v === undefined) {
      throw new Error('secret not found');
    }
    return v;
  }
}

function exchange(over: Partial<MicrosoftTokenExchangeResult> = {}): MicrosoftTokenExchangeResult {
  return {
    access_token: 'ACCESS-SECRET-A',
    refresh_token: 'REFRESH-SECRET-A',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'openid profile offline_access User.Read Mail.Send OnlineMeetings.ReadWrite',
    ms_tenant_id: 'ms-tid-1',
    ms_object_id: 'ms-oid-A',
    ...over,
  };
}

class FakeOAuth {
  next: MicrosoftTokenExchangeResult = exchange();
  revoke = false;
  async exchangeAuthorizationCode(): Promise<MicrosoftTokenExchangeResult> {
    return this.next;
  }
  async refresh(): Promise<MicrosoftTokenExchangeResult> {
    if (this.revoke) {
      throw new MicrosoftConsentRevokedError();
    }
    return exchange({ access_token: 'ACCESS-SECRET-A2', refresh_token: 'REFRESH-SECRET-A2' });
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'COMM-C2B delegated authorization — real Postgres 17 (§4)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: CommunicationsPrismaService;
    let secrets: FakeSecrets;
    let oauth: FakeOAuth;
    let svc: DelegatedAuthorizationService;
    let identities: ProviderIdentityStoreAdapter;

    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();
    const CONN_A = randomUUID();
    const RECRUITER_A = randomUUID();
    const RECRUITER_B = randomUUID();
    const NOW = 1_000_000;

    beforeAll(async () => {
      process.env['ARAMO_ENV'] = 'itest';
      process.env['MSGRAPH_OAUTH_STATE_KEY'] = Buffer.alloc(32, 5).toString('base64url');

      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of communicationsMigrations()) {
        await db.query(readFileSync(p, 'utf8'));
      }
      prisma = new CommunicationsPrismaService(url);
      await prisma.$connect();
      const repo = new CommunicationsRepository(prisma);
      identities = new ProviderIdentityStoreAdapter(repo);
      secrets = new FakeSecrets();
      const tokenStore = new DelegatedTokenSecretStoreAdapter(secrets, secrets);
      oauth = new FakeOAuth();
      svc = new DelegatedAuthorizationService(oauth, tokenStore, identities);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    async function authorize(args: {
      tenant: string;
      connection: string;
      recruiter: string;
      result?: Partial<MicrosoftTokenExchangeResult>;
    }): Promise<string> {
      const { encryptedState } = svc.startAuthorization({
        tenant_id: args.tenant,
        recruiter_id: args.recruiter,
        connection_id: args.connection,
        clientId: 'client-1',
        redirectUri: 'https://app/cb',
        nowEpochSeconds: NOW,
      });
      oauth.next = exchange(args.result);
      const view = await svc.completeAuthorization({
        code: 'code-1',
        encryptedState,
        clientId: 'client-1',
        clientSecret: 'confidential',
        redirectUri: 'https://app/cb',
        nowEpochSeconds: NOW,
      });
      return view.provider_identity_id;
    }

    it('P7 — migration is additive: email_enabled + provider_tenant_id exist with safe defaults', async () => {
      const cols = await db.query(
        `SELECT column_name, data_type, column_default, is_nullable
           FROM information_schema.columns
          WHERE table_schema='communications' AND table_name='CommunicationProviderIdentity'`,
      );
      const byName = new Map(cols.rows.map((r) => [r.column_name as string, r]));
      expect(byName.has('email_enabled')).toBe(true);
      expect(byName.has('provider_tenant_id')).toBe(true);
      expect((byName.get('email_enabled') as { column_default: string }).column_default).toContain('false');
      expect((byName.get('provider_tenant_id') as { is_nullable: string }).is_nullable).toBe('YES');
    });

    it('P1/P6 — token custody is secret-store-only; NO token column or value reaches Postgres', async () => {
      const pid = await authorize({ tenant: TENANT_A, connection: CONN_A, recruiter: RECRUITER_A });

      // The bundle lives in the secret store, keyed by the delegated namespace.
      const secretId = `aramo/itest/msgraph-delegated/${TENANT_A}/${pid}`;
      expect(secrets.map.has(secretId)).toBe(true);
      expect(secrets.map.get(secretId)).toContain('ACCESS-SECRET-A');

      // The PG table has NO token/secret column at all.
      const cols = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='communications' AND table_name='CommunicationProviderIdentity'`,
      );
      const names = (cols.rows as Array<{ column_name: string }>).map((r) => r.column_name);
      expect(names.some((n) => n.includes('token') || n.includes('secret'))).toBe(false);

      // And no token VALUE appears anywhere in the persisted row.
      const row = await db.query(
        `SELECT to_jsonb(t) AS j FROM communications."CommunicationProviderIdentity" t WHERE t.id=$1`,
        [pid],
      );
      const j = JSON.stringify(row.rows[0].j);
      expect(j).not.toContain('ACCESS-SECRET-A');
      expect(j).not.toContain('REFRESH-SECRET-A');
      // The binding itself is correct + provider-neutral columns populated.
      expect(row.rows[0].j.email_enabled).toBe(true);
      expect(row.rows[0].j.provider_user_id).toBe('ms-oid-A');
      expect(row.rows[0].j.provider_tenant_id).toBe('ms-tid-1');
    });

    it('P2 — recruiter A cannot resolve recruiter B’s delegated token', async () => {
      await authorize({
        tenant: TENANT_A,
        connection: CONN_A,
        recruiter: RECRUITER_A,
        result: { access_token: 'ACCESS-A', ms_object_id: 'oid-A' },
      });
      await authorize({
        tenant: TENANT_A,
        connection: CONN_A,
        recruiter: RECRUITER_B,
        result: { access_token: 'ACCESS-B', ms_object_id: 'oid-B' },
      });
      const a = await svc.getUsableAccessToken({
        tenant_id: TENANT_A,
        connection_id: CONN_A,
        recruiter_id: RECRUITER_A,
        clientId: 'client-1',
        nowEpochSeconds: NOW + 60,
      });
      const b = await svc.getUsableAccessToken({
        tenant_id: TENANT_A,
        connection_id: CONN_A,
        recruiter_id: RECRUITER_B,
        clientId: 'client-1',
        nowEpochSeconds: NOW + 60,
      });
      expect(a.access_token).toBe('ACCESS-A');
      expect(b.access_token).toBe('ACCESS-B');
      expect(a.provider_identity_id).not.toBe(b.provider_identity_id);
    });

    it('P3 — tenant A cannot cross into tenant B (binding read is tenant-scoped)', async () => {
      await authorize({ tenant: TENANT_A, connection: CONN_A, recruiter: RECRUITER_A });
      // Same connection + recruiter ids, but a DIFFERENT tenant resolves nothing.
      const crossTenant = await identities.findByRecruiter(TENANT_B, CONN_A, RECRUITER_A);
      expect(crossTenant).toBeNull();
    });

    it('P4 — callback rejects garbage / tampered / expired state (CSRF/PKCE guard)', async () => {
      const { encryptedState } = svc.startAuthorization({
        tenant_id: TENANT_A,
        recruiter_id: RECRUITER_A,
        connection_id: CONN_A,
        clientId: 'client-1',
        redirectUri: 'https://app/cb',
        nowEpochSeconds: NOW,
      });
      // sanity: a good state decrypts
      expect(decryptMicrosoftOAuthState(encryptedState).tenant_id).toBe(TENANT_A);

      await expect(
        svc.completeAuthorization({
          code: 'c',
          encryptedState: 'not-a-real-state',
          clientId: 'client-1',
          redirectUri: 'https://app/cb',
          nowEpochSeconds: NOW,
        }),
      ).rejects.toBeInstanceOf(MicrosoftOAuthStateError);

      const tampered = `${encryptedState.slice(0, -2)}${encryptedState.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
      await expect(
        svc.completeAuthorization({
          code: 'c',
          encryptedState: tampered,
          clientId: 'client-1',
          redirectUri: 'https://app/cb',
          nowEpochSeconds: NOW,
        }),
      ).rejects.toBeInstanceOf(MicrosoftOAuthStateError);

      // expired state (past TTL)
      await expect(
        svc.completeAuthorization({
          code: 'c',
          encryptedState,
          clientId: 'client-1',
          redirectUri: 'https://app/cb',
          nowEpochSeconds: NOW + 601,
        }),
      ).rejects.toBeInstanceOf(MicrosoftOAuthStateError);
    });

    it('P5 — a revoked refresh flips the identity to reauthorization-required and blocks use', async () => {
      const pid = await authorize({ tenant: TENANT_A, connection: CONN_A, recruiter: RECRUITER_A });
      oauth.revoke = true;
      await expect(
        svc.getUsableAccessToken({
          tenant_id: TENANT_A,
          connection_id: CONN_A,
          recruiter_id: RECRUITER_A,
          clientId: 'client-1',
          nowEpochSeconds: NOW + 3600, // past expiry → forces refresh
        }),
      ).rejects.toBeInstanceOf(MicrosoftReauthRequiredError);

      const row = await db.query(
        `SELECT status FROM communications."CommunicationProviderIdentity" WHERE id=$1`,
        [pid],
      );
      expect(row.rows[0].status).toBe('reauth_required');
      oauth.revoke = false;
    });
  },
);
