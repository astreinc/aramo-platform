import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assertNoTokenMaterial, type DelegatedTokenBundle } from '../lib/domain/delegated-token.js';
import { decryptMicrosoftOAuthState } from '../lib/domain/oauth-state.js';
import {
  DelegatedAuthorizationService,
  MicrosoftIdentityNotBoundError,
  MicrosoftReauthRequiredError,
} from '../lib/delegated-authorization.service.js';
import {
  MicrosoftConsentRevokedError,
  type MicrosoftOAuthPort,
  type MicrosoftTokenExchangeResult,
} from '../lib/ports/microsoft-oauth.port.js';
import type {
  DelegatedTokenBinding,
  DelegatedTokenStorePort,
} from '../lib/ports/delegated-token-store.port.js';
import type {
  ProviderIdentityBinding,
  ProviderIdentityStatus,
  ProviderIdentityStorePort,
  UpsertProviderIdentityArgs,
} from '../lib/ports/provider-identity-store.port.js';

// COMM-C2B R2/R4/R6/R7 — the delegated-authorization security core: custody
// off-Postgres, refresh+rotate, revoked→reauth, disabled cannot act, recruiter
// isolation, and token-free returned views.

const TENANT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const CONN = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const RECRUITER_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const RECRUITER_B = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const NOW = 1_000_000;

function exchangeResult(over: Partial<MicrosoftTokenExchangeResult> = {}): MicrosoftTokenExchangeResult {
  return {
    access_token: 'access-A',
    refresh_token: 'refresh-A',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'openid profile offline_access User.Read Mail.Send OnlineMeetings.ReadWrite',
    ms_tenant_id: 'ms-tenant-1',
    ms_object_id: 'ms-oid-A',
    ...over,
  };
}

class FakeOAuth implements MicrosoftOAuthPort {
  next: MicrosoftTokenExchangeResult = exchangeResult();
  refreshResult: MicrosoftTokenExchangeResult = exchangeResult({ access_token: 'access-A2', refresh_token: 'refresh-A2' });
  revokeRefresh = false;
  async exchangeAuthorizationCode(): Promise<MicrosoftTokenExchangeResult> {
    return this.next;
  }
  async refresh(): Promise<MicrosoftTokenExchangeResult> {
    if (this.revokeRefresh) {
      throw new MicrosoftConsentRevokedError();
    }
    return this.refreshResult;
  }
}

class FakeStore implements DelegatedTokenStorePort {
  readonly map = new Map<string, DelegatedTokenBundle>();
  private key(b: DelegatedTokenBinding): string {
    return `${b.tenant_id}:${b.provider_identity_id}`;
  }
  async write(b: DelegatedTokenBinding, bundle: DelegatedTokenBundle): Promise<void> {
    this.map.set(this.key(b), bundle);
  }
  async read(b: DelegatedTokenBinding): Promise<DelegatedTokenBundle | null> {
    return this.map.get(this.key(b)) ?? null;
  }
  async rotate(b: DelegatedTokenBinding, bundle: DelegatedTokenBundle): Promise<void> {
    this.map.set(this.key(b), bundle);
  }
  async remove(b: DelegatedTokenBinding): Promise<void> {
    this.map.delete(this.key(b));
  }
}

class FakeIdentities implements ProviderIdentityStorePort {
  readonly rows = new Map<string, ProviderIdentityBinding>();
  private seq = 0;
  private rk(t: string, c: string, r: string): string {
    return `${t}:${c}:${r}`;
  }
  async upsert(args: UpsertProviderIdentityArgs): Promise<ProviderIdentityBinding> {
    const rk = this.rk(args.tenant_id, args.integration_connection_id, args.recruiter_id);
    const existing = [...this.rows.values()].find(
      (b) => this.rk(b.tenant_id, b.integration_connection_id, b.recruiter_id) === rk,
    );
    const id = existing?.id ?? `pi-${(this.seq += 1)}`;
    const row: ProviderIdentityBinding = {
      id,
      tenant_id: args.tenant_id,
      integration_connection_id: args.integration_connection_id,
      recruiter_id: args.recruiter_id,
      provider_user_id: args.provider_user_id,
      ms_tenant_id: args.ms_tenant_id,
      status: existing?.status ?? 'active',
      email_enabled: args.email_enabled,
    };
    this.rows.set(id, row);
    return row;
  }
  async findByRecruiter(t: string, c: string, r: string): Promise<ProviderIdentityBinding | null> {
    return (
      [...this.rows.values()].find(
        (b) => b.tenant_id === t && b.integration_connection_id === c && b.recruiter_id === r,
      ) ?? null
    );
  }
  async setStatus(t: string, id: string, status: ProviderIdentityStatus): Promise<ProviderIdentityBinding> {
    const row = this.rows.get(id);
    if (row === undefined || row.tenant_id !== t) {
      throw new Error('not found');
    }
    const next = { ...row, status };
    this.rows.set(id, next);
    return next;
  }
  async countByStatus(t: string, c: string): Promise<Record<ProviderIdentityStatus, number>> {
    const acc: Record<ProviderIdentityStatus, number> = { active: 0, unmapped: 0, disabled: 0, reauth_required: 0 };
    for (const b of this.rows.values()) {
      if (b.tenant_id === t && b.integration_connection_id === c) {
        acc[b.status] += 1;
      }
    }
    return acc;
  }
}

describe('COMM-C2B delegated authorization (R2/R4/R6/R7)', () => {
  let oauth: FakeOAuth;
  let store: FakeStore;
  let identities: FakeIdentities;
  let svc: DelegatedAuthorizationService;

  beforeAll(() => {
    process.env['MSGRAPH_OAUTH_STATE_KEY'] = Buffer.alloc(32, 9).toString('base64url');
  });
  beforeEach(() => {
    oauth = new FakeOAuth();
    store = new FakeStore();
    identities = new FakeIdentities();
    svc = new DelegatedAuthorizationService(oauth, store, identities);
  });

  const startArgs = {
    tenant_id: TENANT,
    recruiter_id: RECRUITER_A,
    connection_id: CONN,
    clientId: 'client-1',
    redirectUri: 'https://app/cb',
    nowEpochSeconds: NOW,
  };

  it('startAuthorization emits an authorize URL and a state that decrypts to the binding', () => {
    const { authorizeUrl, encryptedState } = svc.startAuthorization(startArgs);
    expect(authorizeUrl).toContain('login.microsoftonline.com');
    const state = decryptMicrosoftOAuthState(encryptedState);
    expect(state.tenant_id).toBe(TENANT);
    expect(state.recruiter_id).toBe(RECRUITER_A);
    expect(state.connection_id).toBe(CONN);
    expect(state.verifier.length).toBeGreaterThan(0);
  });

  async function authorize(recruiter: string, over: Partial<MicrosoftTokenExchangeResult> = {}): Promise<string> {
    const { encryptedState } = svc.startAuthorization({ ...startArgs, recruiter_id: recruiter });
    oauth.next = exchangeResult(over);
    const view = await svc.completeAuthorization({
      code: 'code-1',
      encryptedState,
      clientId: 'client-1',
      redirectUri: 'https://app/cb',
      nowEpochSeconds: NOW,
    });
    return view.provider_identity_id;
  }

  it('completeAuthorization binds identity, stores the token, and returns NO token material (R3)', async () => {
    const { encryptedState } = svc.startAuthorization(startArgs);
    const view = await svc.completeAuthorization({
      code: 'code-1',
      encryptedState,
      clientId: 'client-1',
      redirectUri: 'https://app/cb',
      nowEpochSeconds: NOW,
    });
    expect(view.status).toBe('active');
    expect(view.ms_object_id).toBe('ms-oid-A');
    expect(() => assertNoTokenMaterial(view)).not.toThrow(); // R3: token-free view
    // Token IS in custody, keyed by the binding.
    const stored = await store.read({ tenant_id: TENANT, provider_identity_id: view.provider_identity_id });
    expect(stored?.access_token).toBe('access-A');
  });

  it('rejects an expired state on callback (CSRF/replay guard)', async () => {
    const { encryptedState } = svc.startAuthorization(startArgs);
    await expect(
      svc.completeAuthorization({
        code: 'code-1',
        encryptedState,
        clientId: 'client-1',
        redirectUri: 'https://app/cb',
        nowEpochSeconds: NOW + 601,
      }),
    ).rejects.toThrow();
  });

  it('getUsableAccessToken returns the stored token when fresh', async () => {
    await authorize(RECRUITER_A);
    const t = await svc.getUsableAccessToken({
      tenant_id: TENANT,
      connection_id: CONN,
      recruiter_id: RECRUITER_A,
      clientId: 'client-1',
      nowEpochSeconds: NOW + 60,
    });
    expect(t.access_token).toBe('access-A');
  });

  it('refreshes + rotates custody when the token is near expiry (R4)', async () => {
    const pid = await authorize(RECRUITER_A);
    const t = await svc.getUsableAccessToken({
      tenant_id: TENANT,
      connection_id: CONN,
      recruiter_id: RECRUITER_A,
      clientId: 'client-1',
      nowEpochSeconds: NOW + 3600, // past expiry
    });
    expect(t.access_token).toBe('access-A2');
    const rotated = await store.read({ tenant_id: TENANT, provider_identity_id: pid });
    expect(rotated?.access_token).toBe('access-A2');
    expect(rotated?.refresh_token).toBe('refresh-A2');
  });

  it('flips to reauth_required and throws when the refresh is revoked (R4/R7/R19)', async () => {
    const pid = await authorize(RECRUITER_A);
    oauth.revokeRefresh = true;
    await expect(
      svc.getUsableAccessToken({
        tenant_id: TENANT,
        connection_id: CONN,
        recruiter_id: RECRUITER_A,
        clientId: 'client-1',
        nowEpochSeconds: NOW + 3600,
      }),
    ).rejects.toBeInstanceOf(MicrosoftReauthRequiredError);
    expect(identities.rows.get(pid)?.status).toBe('reauth_required');
  });

  it('a disabled identity cannot act (R7)', async () => {
    const pid = await authorize(RECRUITER_A);
    await identities.setStatus(TENANT, pid, 'disabled');
    await expect(
      svc.getUsableAccessToken({
        tenant_id: TENANT,
        connection_id: CONN,
        recruiter_id: RECRUITER_A,
        clientId: 'client-1',
        nowEpochSeconds: NOW + 60,
      }),
    ).rejects.toBeInstanceOf(MicrosoftReauthRequiredError);
  });

  it('recruiter A cannot resolve recruiter B’s delegated token (R6/§4.6)', async () => {
    await authorize(RECRUITER_A, { access_token: 'access-A', ms_object_id: 'ms-oid-A' });
    await authorize(RECRUITER_B, { access_token: 'access-B', ms_object_id: 'ms-oid-B' });
    const a = await svc.getUsableAccessToken({
      tenant_id: TENANT,
      connection_id: CONN,
      recruiter_id: RECRUITER_A,
      clientId: 'client-1',
      nowEpochSeconds: NOW + 60,
    });
    expect(a.access_token).toBe('access-A');
    expect(a.ms_object_id).toBe('ms-oid-A');
  });

  it('throws NotBound when no identity exists for the recruiter', async () => {
    await expect(
      svc.getUsableAccessToken({
        tenant_id: TENANT,
        connection_id: CONN,
        recruiter_id: RECRUITER_A,
        clientId: 'client-1',
        nowEpochSeconds: NOW,
      }),
    ).rejects.toBeInstanceOf(MicrosoftIdentityNotBoundError);
  });

  it('revoke disables the binding and purges custody (R7)', async () => {
    const pid = await authorize(RECRUITER_A);
    await svc.revoke(TENANT, CONN, RECRUITER_A);
    expect(identities.rows.get(pid)?.status).toBe('disabled');
    expect(await store.read({ tenant_id: TENANT, provider_identity_id: pid })).toBeNull();
  });
});
