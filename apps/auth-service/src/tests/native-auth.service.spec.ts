import { createHash } from 'node:crypto';

import { decodeJwt } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';
import {
  NativeDeviceSessionService,
  RefreshTokenService,
  RotationRaceError,
  type CodeRedemptionOutcome,
  type NativeDeviceSessionDto,
  type RefreshTokenDto,
} from '@aramo/auth-storage';
import {
  JwtIssuerService,
  NATIVE_REFRESH_CONSUMER,
  NativeAuthService,
  parseNativeTokenRequest,
  type AuditRecord,
  type AuditSink,
  type CognitoVerifierService,
  type NativeTokenRequest,
  type PrincipalDirectory,
  type ResolveScopesInput,
  type ResolveScopesResult,
  type ResolveSessionInput,
  type ResolveSessionResult,
} from '@aramo/auth-core';

import {
  APP_LINK_CALLBACK,
  BROWSER_CLIENT_ID,
  FakeCognito,
  NATIVE_CLIENT_ID,
  SCHEME_CALLBACK,
  ensureVerifierLoaded,
  localJwksVerifier,
  nativeEnv,
  newVerifier,
  type FakeIdentity,
} from './native-auth.test-fixtures.js';
import { generateTestKeyPair } from './test-keys.js';

// AUTH-SIGNIN-1 Amendment M-A1 — NativeAuthService units against an in-memory
// auth store (the REAL RefreshTokenService / NativeDeviceSessionService over
// in-memory repositories), the REAL CognitoVerifierService (local JWKS) and the
// REAL JwtIssuerService. Cognito is a fake (never called). Covers every M-A1 §5
// case: PKCE mismatch, nonce/state replay, wrong audience, provider pin incl.
// Personal Microsoft, capability loss at refresh, refresh reuse, device revoke,
// cross-user listing, code replay across device/client/redirect, and
// revoke/rotate attempts with another user's device id.

const sha = (s: string): string => createHash('sha256').update(s).digest('base64url');

// ── in-memory auth_storage ───────────────────────────────────────────────────
class MemoryStore {
  tokens = new Map<string, RefreshTokenDto>();
  sessions = new Map<string, NativeDeviceSessionDto>();
  ledger = new Map<string, { nonce_hash: string; expires_at: Date }>();

  private newToken(a: { user_id: string; tenant_id: string; consumer_type: string; token_hash: string; expires_at: Date }): RefreshTokenDto {
    const now = new Date().toISOString();
    const t: RefreshTokenDto = {
      id: uuidv7(),
      user_id: a.user_id,
      tenant_id: a.tenant_id,
      consumer_type: a.consumer_type,
      token_hash: a.token_hash,
      created_at: now,
      updated_at: now,
      expires_at: a.expires_at.toISOString(),
      revoked_at: null,
      replaced_by_id: null,
    };
    this.tokens.set(t.id, t);
    return t;
  }

  refreshRepo = {
    create: async (a: { user_id: string; tenant_id: string; consumer_type: string; token_hash: string; expires_at: Date }) => this.newToken(a),
    findByHash: async ({ token_hash }: { token_hash: string }) => [...this.tokens.values()].find((t) => t.token_hash === token_hash) ?? null,
    revoke: async ({ id }: { id: string }) => {
      const t = this.tokens.get(id)!;
      t.revoked_at = new Date().toISOString();
      return t;
    },
    revokeAllForUser: async ({ user_id }: { user_id: string }) => {
      let n = 0;
      for (const t of this.tokens.values()) {
        if (t.user_id === user_id && t.revoked_at === null) {
          t.revoked_at = new Date().toISOString();
          n += 1;
        }
      }
      return { revoked_count: n };
    },
    rotate: async () => {
      throw new Error('browser rotate is not used by the native path');
    },
  };

  sessionRepo = {
    redeemCode: async (a: { code_hash: string; nonce_hash: string; expires_at: Date }): Promise<CodeRedemptionOutcome> => {
      if (this.ledger.has(a.code_hash)) return 'code_already_redeemed';
      if ([...this.ledger.values()].some((r) => r.nonce_hash === a.nonce_hash)) return 'nonce_replayed';
      this.ledger.set(a.code_hash, { nonce_hash: a.nonce_hash, expires_at: a.expires_at });
      return 'redeemed';
    },
    createSession: async (a: {
      user_id: string; tenant_id: string; consumer_type: string; refresh_consumer_type: string; client_id: string;
      installation_id: string; platform: 'ios' | 'android'; app_version: string; token_hash: string; expires_at: Date;
    }) => {
      const t = this.newToken({ ...a, consumer_type: a.refresh_consumer_type });
      const now = new Date().toISOString();
      const s: NativeDeviceSessionDto = {
        id: uuidv7(),
        user_id: a.user_id,
        tenant_id: a.tenant_id,
        consumer_type: a.consumer_type,
        client_id: a.client_id,
        installation_id: a.installation_id,
        platform: a.platform,
        app_version: a.app_version,
        refresh_family_root_id: t.id,
        current_refresh_token_id: t.id,
        created_at: now,
        last_seen_at: now,
        revoked_at: null,
        revoke_reason: null,
      };
      this.sessions.set(s.id, s);
      return { session: { ...s }, refresh_token_id: t.id };
    },
    findById: async (id: string) => {
      const s = this.sessions.get(id);
      return s === undefined ? null : { ...s };
    },
    findLiveById: async (id: string) => {
      const s = this.sessions.get(id);
      if (s === undefined || s.revoked_at !== null) return null;
      const t = this.tokens.get(s.current_refresh_token_id);
      if (t === undefined || t.revoked_at !== null || Date.parse(t.expires_at) <= Date.now()) return null;
      return { ...s };
    },
    findActiveByCurrentToken: async (tid: string) => {
      const s = [...this.sessions.values()].find((x) => x.current_refresh_token_id === tid && x.revoked_at === null);
      return s === undefined ? null : { ...s };
    },
    rotateForSession: async (a: { session_id: string; old_token_id: string; new_token_hash: string; new_expires_at: Date }) => {
      const old = this.tokens.get(a.old_token_id)!;
      const s = this.sessions.get(a.session_id)!;
      if (old.revoked_at !== null || old.replaced_by_id !== null) throw new RotationRaceError();
      if (s.revoked_at !== null || s.current_refresh_token_id !== old.id) throw new RotationRaceError();
      const n = this.newToken({ user_id: old.user_id, tenant_id: old.tenant_id, consumer_type: old.consumer_type, token_hash: a.new_token_hash, expires_at: a.new_expires_at });
      old.revoked_at = new Date().toISOString();
      old.replaced_by_id = n.id;
      s.current_refresh_token_id = n.id;
      s.last_seen_at = new Date().toISOString();
      return { new_token_id: n.id, session: { ...s } };
    },
    listActiveForUser: async ({ user_id, tenant_id }: { user_id: string; tenant_id: string }) =>
      [...this.sessions.values()]
        .filter((s) => s.user_id === user_id && s.tenant_id === tenant_id && s.revoked_at === null)
        .filter((s) => this.tokens.get(s.current_refresh_token_id)?.revoked_at === null)
        .map((s) => ({ ...s })),
    revokeSession: async ({ id, reason }: { id: string; reason: string }) => {
      const s = this.sessions.get(id);
      if (s === undefined || s.revoked_at !== null) return false;
      s.revoked_at = new Date().toISOString();
      s.revoke_reason = reason;
      const cur = this.tokens.get(s.current_refresh_token_id);
      if (cur !== undefined && cur.revoked_at === null) cur.revoked_at = new Date().toISOString();
      return true;
    },
    revokeAllForUser: async ({ user_id, reason }: { user_id: string; reason: string }) => {
      let n = 0;
      for (const s of this.sessions.values()) {
        if (s.user_id === user_id && s.revoked_at === null) {
          s.revoked_at = new Date().toISOString();
          s.revoke_reason = reason;
          n += 1;
        }
      }
      return { revoked_count: n };
    },
  };
}

// ── principal directory: the Personal tenant policy (Google-only) emulated ───
const USER_A = '01900000-0000-7000-8000-00000000000a';
const USER_B = '01900000-0000-7000-8000-00000000000b';
const TENANT = '01900000-0000-7000-8000-0000000000aa';

class FakePrincipals implements PrincipalDirectory {
  sessionCalls: ResolveSessionInput[] = [];
  scopesCalls: ResolveScopesInput[] = [];
  // sub → user id; a sub not listed is not provisioned (no JIT).
  users = new Map<string, string>([
    ['sub-a', USER_A],
    ['sub-b', USER_B],
  ]);
  googleOnly = false;
  denyScopes: string | null = null;
  denySession: string | null = null;
  async resolveSession(input: ResolveSessionInput): Promise<ResolveSessionResult> {
    this.sessionCalls.push(input);
    const id = this.users.get(input.provider_subject);
    if (id === undefined) return { kind: 'denied', reason: 'user_not_provisioned' };
    if (this.googleOnly && input.idp !== 'google') return { kind: 'denied', reason: 'idp_not_permitted_for_tenant' };
    if (this.denySession !== null) return { kind: 'denied', reason: this.denySession };
    return { kind: 'resolved', principal_id: id, context_id: TENANT, scopes: ['esign:envelope:read'], authz_version: 3 };
  }
  async resolveScopes(input: ResolveScopesInput): Promise<ResolveScopesResult> {
    this.scopesCalls.push(input);
    if (this.denyScopes !== null) return { kind: 'denied', reason: this.denyScopes };
    return { kind: 'resolved', scopes: ['esign:envelope:read'], authz_version: 4 };
  }
}

class MemoryAudit implements AuditSink {
  events: AuditRecord[] = [];
  async record(e: AuditRecord): Promise<void> {
    this.events.push(e);
  }
}

const ALICE: FakeIdentity = { sub: 'sub-a', email: 'alice@example.com', idp: 'google' };
const BOB: FakeIdentity = { sub: 'sub-b', email: 'bob@example.com', idp: 'google' };

describe('NativeAuthService (M-A1)', () => {
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    ...Object.keys(nativeEnv()),
    'AUTH_AUDIENCE',
    'AUTH_PRIVATE_KEY',
    'AUTH_COGNITO_ISSUER',
    'SIGN_NATIVE_REDIRECT_URIS',
    'AUTH_REFRESH_GRACE_SECONDS',
  ];
  let keys: { privatePem: string };
  let store: MemoryStore;
  let fake: FakeCognito;
  let verifier: CognitoVerifierService;
  let principals: FakePrincipals;
  let audit: MemoryAudit;
  let svc: NativeAuthService;

  beforeAll(() => {
    keys = generateTestKeyPair();
    fake = new FakeCognito();
  });

  beforeEach(async () => {
    for (const k of envKeys) saved[k] = process.env[k];
    Object.assign(process.env, nativeEnv());
    delete process.env['AUTH_COGNITO_ISSUER'];
    delete process.env['SIGN_NATIVE_REDIRECT_URIS'];
    process.env['AUTH_AUDIENCE'] = 'aramo-test';
    process.env['AUTH_PRIVATE_KEY'] = keys.privatePem;
    process.env['AUTH_REFRESH_GRACE_SECONDS'] = '30';
    store = new MemoryStore();
    fake.exchangeCalls = 0;
    verifier = localJwksVerifier(fake);
    await ensureVerifierLoaded(verifier);
    principals = new FakePrincipals();
    audit = new MemoryAudit();
    svc = new NativeAuthService(
      fake,
      verifier,
      principals,
      new RefreshTokenService(store.refreshRepo as never),
      new NativeDeviceSessionService(store.sessionRepo as never),
      new JwtIssuerService(),
      audit,
    );
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function signIn(identity: FakeIdentity = ALICE, over: Partial<NativeTokenRequest> & { authorize?: Parameters<FakeCognito['authorize']>[0] } = {}): NativeTokenRequest {
    const verifierStr = newVerifier();
    const nonce = `nonce-${Math.random()}`;
    const code = fake.authorize(over.authorize ?? { verifier: verifierStr, nonce, identity });
    return {
      code,
      code_verifier: verifierStr,
      redirect_uri: APP_LINK_CALLBACK,
      nonce,
      device: { installation_id: 'inst-1', platform: 'ios', app_version: '1.0.0' },
      ...over,
    };
  }

  async function expectRefusal(p: Promise<unknown>, code: string, status: number, reason: string): Promise<void> {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AramoError);
    expect(err).toMatchObject({ code, statusCode: status, context: { details: { reason } } });
  }

  describe('exchange', () => {
    it('mints the existing Aramo JWT (sign, 900 s) + client native + dsid, stores the refresh token hashed, and audits the native context', async () => {
      const out = await svc.exchange(signIn(), 'r1');
      expect(out.token_type).toBe('Bearer');
      expect(out.expires_in).toBe(900);
      const claims = decodeJwt(out.access_token);
      expect(claims).toMatchObject({ sub: USER_A, consumer_type: 'sign', tenant_id: TENANT, authz_version: 3, client: 'native', dsid: out.device_session_id });
      expect((claims.exp as number) - (claims.iat as number)).toBe(900);
      // Hashed at rest; plaintext nowhere in the store.
      const row = [...store.tokens.values()][0]!;
      expect(row.token_hash).toBe(sha(out.refresh_token));
      expect(JSON.stringify([...store.tokens.values()])).not.toContain(out.refresh_token);
      expect(row.consumer_type).toBe(NATIVE_REFRESH_CONSUMER);
      // Device session bound to user, tenant, native client, refresh family.
      const s = store.sessions.get(out.device_session_id)!;
      expect(s).toMatchObject({ user_id: USER_A, tenant_id: TENANT, consumer_type: 'sign', client_id: NATIVE_CLIENT_ID, refresh_family_root_id: row.id, current_refresh_token_id: row.id, platform: 'ios' });
      // Same principal resolution as the browser, flagged native, no host context.
      expect(principals.sessionCalls[0]).toMatchObject({ consumer: 'sign', client: 'native', idp: 'google', provider_subject: 'sub-a' });
      expect('host_class' in principals.sessionCalls[0]!).toBe(false);
      expect(audit.events[0]).toMatchObject({ event_type: 'identity.session.issued', payload: { client: 'native', device_session_id: out.device_session_id, platform: 'ios' } });
      expect(JSON.stringify(audit.events)).not.toContain(out.refresh_token);
      expect(JSON.stringify(audit.events)).not.toContain(out.access_token);
    });

    it('redirect_uri must be byte-equal to an allow-listed native callback (no burn, no exchange)', async () => {
      for (const redirect_uri of [`${APP_LINK_CALLBACK}/`, 'https://evil.example/auth/native/callback', 'ARAMOSIGN://auth/callback', `${APP_LINK_CALLBACK}?x=1`]) {
        await expectRefusal(svc.exchange(signIn(ALICE, { redirect_uri }), 'r'), 'VALIDATION_ERROR', 400, 'redirect_uri_not_allowed');
      }
      expect(fake.exchangeCalls).toBe(0);
      expect(store.ledger.size).toBe(0);
      // The custom-scheme fallback is allow-listed by default.
      const verifierStr = newVerifier();
      const code = fake.authorize({ verifier: verifierStr, nonce: 'n-s', identity: ALICE, redirect_uri: SCHEME_CALLBACK });
      const ok = await svc.exchange({ ...signIn(), code, code_verifier: verifierStr, nonce: 'n-s', redirect_uri: SCHEME_CALLBACK }, 'r');
      expect(ok.device_session_id).toBeDefined();
    });

    it('SIGN_NATIVE_REDIRECT_URIS overrides the allow-list', async () => {
      process.env['SIGN_NATIVE_REDIRECT_URIS'] = SCHEME_CALLBACK;
      await expectRefusal(svc.exchange(signIn(), 'r'), 'VALIDATION_ERROR', 400, 'redirect_uri_not_allowed');
    });

    it('code replay across DEVICE: the second redemption is refused by the ledger (Cognito never asked twice)', async () => {
      const req = signIn();
      await svc.exchange(req, 'r');
      await expectRefusal(
        svc.exchange({ ...req, device: { installation_id: 'other-phone', platform: 'android', app_version: '9' } }, 'r'),
        'INVALID_TOKEN',
        401,
        'code_already_redeemed',
      );
      expect(fake.exchangeCalls).toBe(1);
      expect(store.sessions.size).toBe(1);
    });

    it('code replay across REDIRECT URI: an already-redeemed code on the other allow-listed callback is refused', async () => {
      const req = signIn();
      await svc.exchange(req, 'r');
      await expectRefusal(svc.exchange({ ...req, redirect_uri: SCHEME_CALLBACK }, 'r'), 'INVALID_TOKEN', 401, 'code_already_redeemed');
    });

    it('a redirect URI differing from the authorize request is rejected by the exchange (invalid_grant)', async () => {
      const verifierStr = newVerifier();
      const code = fake.authorize({ verifier: verifierStr, nonce: 'n-r', identity: ALICE, redirect_uri: APP_LINK_CALLBACK });
      await expectRefusal(svc.exchange({ ...signIn(), code, code_verifier: verifierStr, nonce: 'n-r', redirect_uri: SCHEME_CALLBACK }, 'r'), 'INVALID_TOKEN', 401, 'code_exchange_rejected');
    });

    it('code replay across CLIENT: a code issued to the browser client is refused (exchange rejects), and an ID token for another audience is refused', async () => {
      const v1 = newVerifier();
      const browserCode = fake.authorize({ client_id: BROWSER_CLIENT_ID, verifier: v1, nonce: 'n-c1', identity: ALICE });
      await expectRefusal(svc.exchange({ ...signIn(), code: browserCode, code_verifier: v1, nonce: 'n-c1' }, 'r'), 'INVALID_TOKEN', 401, 'code_exchange_rejected');
      const v2 = newVerifier();
      const wrongAud = fake.authorize({ verifier: v2, nonce: 'n-c2', identity: ALICE, aud: BROWSER_CLIENT_ID });
      await expectRefusal(svc.exchange({ ...signIn(), code: wrongAud, code_verifier: v2, nonce: 'n-c2' }, 'r'), 'INVALID_TOKEN', 401, 'id_token_audience_mismatch');
      expect(store.sessions.size).toBe(0);
    });

    it('wrong issuer is refused', async () => {
      const v = newVerifier();
      const code = fake.authorize({ verifier: v, nonce: 'n-i', identity: ALICE, iss: 'https://evil.example' });
      await expectRefusal(svc.exchange({ ...signIn(), code, code_verifier: v, nonce: 'n-i' }, 'r'), 'INVALID_TOKEN', 401, 'id_token_issuer_mismatch');
    });

    it('PKCE mismatch: a wrong code_verifier is rejected by the exchange; a malformed verifier never reaches it', async () => {
      const req = signIn();
      await expectRefusal(svc.exchange({ ...req, code_verifier: newVerifier() }, 'r'), 'INVALID_TOKEN', 401, 'code_exchange_rejected');
      // The code is burned by the failed attempt: the genuine verifier cannot retry it.
      await expectRefusal(svc.exchange(req, 'r'), 'INVALID_TOKEN', 401, 'code_already_redeemed');
      expect(() => parseNativeTokenRequest({ ...signIn(), code_verifier: 'short' }, 'r')).toThrow(AramoError);
    });

    it('nonce: a mismatch and an absent nonce are refused; a nonce is single-use across codes (replay)', async () => {
      const v1 = newVerifier();
      const c1 = fake.authorize({ verifier: v1, nonce: 'issued-nonce', identity: ALICE });
      await expectRefusal(svc.exchange({ ...signIn(), code: c1, code_verifier: v1, nonce: 'posted-other-nonce' }, 'r'), 'INVALID_TOKEN', 401, 'nonce_mismatch');
      const v2 = newVerifier();
      const c2 = fake.authorize({ verifier: v2, nonce: null, identity: ALICE });
      await expectRefusal(svc.exchange({ ...signIn(), code: c2, code_verifier: v2, nonce: 'n-absent' }, 'r'), 'INVALID_TOKEN', 401, 'nonce_missing');
      const first = signIn();
      await svc.exchange(first, 'r');
      const v3 = newVerifier();
      const c3 = fake.authorize({ verifier: v3, nonce: first.nonce, identity: ALICE });
      await expectRefusal(svc.exchange({ ...signIn(), code: c3, code_verifier: v3, nonce: first.nonce }, 'r'), 'INVALID_TOKEN', 401, 'nonce_replayed');
    });

    it('provider pin: a Personal (Google-only) tenant refuses Microsoft with idp_not_permitted_for_tenant; Google is accepted', async () => {
      principals.googleOnly = true;
      await expectRefusal(svc.exchange(signIn({ ...ALICE, idp: 'microsoft' }), 'r'), 'TENANT_ACCESS_DENIED', 403, 'idp_not_permitted_for_tenant');
      expect(principals.sessionCalls[0]).toMatchObject({ idp: 'microsoft', client: 'native' });
      expect(store.sessions.size).toBe(0);
      const ok = await svc.exchange(signIn(ALICE), 'r');
      expect(ok.device_session_id).toBeDefined();
    });

    it('no JIT: an unprovisioned identity is refused and nothing is created', async () => {
      await expectRefusal(svc.exchange(signIn({ sub: 'sub-unknown', email: 'x@example.com', idp: 'google' }), 'r'), 'INSUFFICIENT_PERMISSIONS', 403, 'user_not_provisioned');
      expect(store.sessions.size).toBe(0);
      expect(store.tokens.size).toBe(0);
    });

    it('capability `sign` is required at mint (consumer_not_entitled → 403 TENANT_CAPABILITY_NOT_ENTITLED)', async () => {
      principals.denySession = 'consumer_not_entitled';
      await expectRefusal(svc.exchange(signIn(), 'r'), 'TENANT_CAPABILITY_NOT_ENTITLED', 403, 'consumer_not_entitled');
    });

    it('refuses when the native client is not configured', async () => {
      delete process.env['SIGN_NATIVE_COGNITO_CLIENT_ID'];
      await expectRefusal(svc.exchange(signIn(), 'r'), 'INTERNAL_ERROR', 500, 'native_client_not_configured');
    });
  });

  describe('refresh', () => {
    it('returns a rotated pair bound to the same device session; capability + consumer re-checked', async () => {
      const first = await svc.exchange(signIn(), 'r');
      const second = await svc.refresh(first.refresh_token, 'r');
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(second.device_session_id).toBe(first.device_session_id);
      expect(decodeJwt(second.access_token)).toMatchObject({ client: 'native', dsid: first.device_session_id, consumer_type: 'sign', authz_version: 4 });
      expect(principals.scopesCalls[0]).toEqual({ principal_id: USER_A, context_id: TENANT, consumer: 'sign' });
      const s = store.sessions.get(first.device_session_id)!;
      expect(store.tokens.get(s.current_refresh_token_id)!.token_hash).toBe(sha(second.refresh_token));
      expect(audit.events.at(-1)).toMatchObject({ event_type: 'identity.session.refreshed', payload: { client: 'native', device_session_id: first.device_session_id } });
    });

    it('capability loss at refresh: 401 consumer_not_entitled, the device session and its family are revoked, a retained token cannot resume', async () => {
      const first = await svc.exchange(signIn(), 'r');
      principals.denyScopes = 'consumer_not_entitled';
      await expectRefusal(svc.refresh(first.refresh_token, 'r'), 'REFRESH_TOKEN_INVALID', 401, 'consumer_not_entitled');
      expect(store.sessions.get(first.device_session_id)!.revoked_at).not.toBeNull();
      expect(audit.events.at(-1)).toMatchObject({ event_type: 'identity.session.revoked', payload: { reason: 'refresh_denied:consumer_not_entitled', client: 'native' } });
      principals.denyScopes = null;
      await expectRefusal(svc.refresh(first.refresh_token, 'r'), 'REFRESH_TOKEN_INVALID', 401, 'explicitly_revoked');
    });

    it('reuse of a rotated token (past grace) → the existing R.2 cascade: every refresh token of the user revoked, reuse_detected audited, native sessions closed', async () => {
      const a1 = await svc.exchange(signIn(), 'r');
      const a2 = await svc.exchange(signIn(), 'r'); // a second device of the same user
      const rotated = await svc.refresh(a1.refresh_token, 'r');
      // Age the rotation past the grace window.
      const old = [...store.tokens.values()].find((t) => t.token_hash === sha(a1.refresh_token))!;
      old.revoked_at = new Date(Date.now() - 120_000).toISOString();
      await expectRefusal(svc.refresh(a1.refresh_token, 'r'), 'REFRESH_TOKEN_INVALID', 401, 'reuse_detected');
      expect([...store.tokens.values()].every((t) => t.revoked_at !== null)).toBe(true);
      expect([...store.sessions.values()].every((s) => s.revoked_at !== null && s.revoke_reason === 'reuse_detected')).toBe(true);
      expect(audit.events.at(-1)).toMatchObject({ event_type: 'identity.session.reuse_detected', actor_id: USER_A, payload: { client: 'native' } });
      await expectRefusal(svc.refresh(rotated.refresh_token, 'r'), 'REFRESH_TOKEN_INVALID', 401, 'explicitly_revoked');
      await expectRefusal(svc.refresh(a2.refresh_token, 'r'), 'REFRESH_TOKEN_INVALID', 401, 'explicitly_revoked');
    });

    it('a rotated token inside the grace window is a rotation race, not a new session', async () => {
      const a = await svc.exchange(signIn(), 'r');
      await svc.refresh(a.refresh_token, 'r');
      await expectRefusal(svc.refresh(a.refresh_token, 'r'), 'REFRESH_TOKEN_INVALID', 401, 'rotation_race');
    });

    it('a browser `sign` refresh token is refused on the native route (consumer_mismatch); unknown → not_found', async () => {
      const browser = await new RefreshTokenService(store.refreshRepo as never).create({
        user_id: USER_A, tenant_id: TENANT, consumer_type: 'sign', token_hash: sha('browser-plain'), expires_at: new Date(Date.now() + 60_000),
      });
      expect(browser.consumer_type).toBe('sign');
      await expectRefusal(svc.refresh('browser-plain', 'r'), 'REFRESH_TOKEN_INVALID', 401, 'consumer_mismatch');
      await expectRefusal(svc.refresh('never-issued', 'r'), 'REFRESH_TOKEN_INVALID', 401, 'not_found');
    });

    it('the device session is resolved from the refresh token only: a body naming another user\'s device cannot rotate it', async () => {
      const a = await svc.exchange(signIn(ALICE), 'r');
      const b = await svc.exchange(signIn(BOB), 'r');
      const bCurrent = store.sessions.get(b.device_session_id)!.current_refresh_token_id;
      // The controller parses ONLY refresh_token; an injected device id is ignored.
      const out = await svc.refresh(a.refresh_token, 'r');
      expect(out.device_session_id).toBe(a.device_session_id);
      expect(store.sessions.get(b.device_session_id)!.current_refresh_token_id).toBe(bCurrent);
    });
  });

  describe('logout + device sessions', () => {
    it('logout revokes that device session and its refresh family; idempotent for unknown tokens', async () => {
      const a = await svc.exchange(signIn(), 'r');
      await svc.logout(a.refresh_token);
      expect(store.sessions.get(a.device_session_id)!.revoke_reason).toBe('logout');
      await expectRefusal(svc.refresh(a.refresh_token, 'r'), 'REFRESH_TOKEN_INVALID', 401, 'explicitly_revoked');
      await expect(svc.logout('never-issued')).resolves.toBeUndefined();
      await expect(svc.logout(a.refresh_token)).resolves.toBeUndefined();
    });

    it('lists ONLY the caller\'s own sessions (cross-user listing shows nothing of another user) with the current flag', async () => {
      const a1 = await svc.exchange(signIn(ALICE), 'r');
      const a2 = await svc.exchange({ ...signIn(ALICE), device: { installation_id: 'ipad', platform: 'android', app_version: '2.0.0' } }, 'r');
      const b = await svc.exchange(signIn(BOB), 'r');
      const list = await svc.listSessions({ sub: USER_A, tenant_id: TENANT, dsid: a1.device_session_id }, 'r');
      expect(list.items.map((i) => i.device_session_id).sort()).toEqual([a1.device_session_id, a2.device_session_id].sort());
      expect(list.items.find((i) => i.device_session_id === a1.device_session_id)!.current).toBe(true);
      expect(list.items.find((i) => i.device_session_id === a2.device_session_id)).toMatchObject({ current: false, platform: 'android', app_version: '2.0.0' });
      expect(JSON.stringify(list)).not.toContain(b.device_session_id);
      expect(JSON.stringify(list)).not.toContain('installation_id');
    });

    it('revoke with another user\'s device session id → 404 (nothing revealed, nothing revoked); malformed id → the same 404', async () => {
      const a = await svc.exchange(signIn(ALICE), 'r');
      const b = await svc.exchange(signIn(BOB), 'r');
      const callerA = { sub: USER_A, tenant_id: TENANT, dsid: a.device_session_id };
      await expectRefusal(svc.revokeSession(callerA, b.device_session_id, 'r'), 'NOT_FOUND', 404, 'device_session_not_found');
      expect(store.sessions.get(b.device_session_id)!.revoked_at).toBeNull();
      await expectRefusal(svc.revokeSession(callerA, 'not-a-uuid', 'r'), 'NOT_FOUND', 404, 'device_session_not_found');
      await expectRefusal(svc.revokeSession(callerA, uuidv7(), 'r'), 'NOT_FOUND', 404, 'device_session_not_found');
      // A caller token naming another tenant does not own even its own dsid there.
      await expectRefusal(svc.revokeSession({ ...callerA, tenant_id: '01900000-0000-7000-8000-0000000000ff', dsid: a.device_session_id }, a.device_session_id, 'r'), 'INVALID_TOKEN', 401, 'device_session_revoked');
    });

    it('a user-wide token revocation made outside the native path (browser R.2 cascade) ends the native session for list/revoke too', async () => {
      const a = await svc.exchange(signIn(ALICE), 'r');
      await new RefreshTokenService(store.refreshRepo as never).revokeAllForUser({ user_id: USER_A });
      await expectRefusal(svc.listSessions({ sub: USER_A, tenant_id: TENANT, dsid: a.device_session_id }, 'r'), 'INVALID_TOKEN', 401, 'device_session_revoked');
      await expectRefusal(svc.refresh(a.refresh_token, 'r'), 'REFRESH_TOKEN_INVALID', 401, 'explicitly_revoked');
    });

    it('device revoke kills that device\'s refresh family; a revoked device can no longer list or revoke', async () => {
      const phone = await svc.exchange(signIn(ALICE), 'r');
      const tablet = await svc.exchange(signIn(ALICE), 'r');
      const fromPhone = { sub: USER_A, tenant_id: TENANT, dsid: phone.device_session_id };
      await svc.revokeSession(fromPhone, tablet.device_session_id, 'r');
      await expectRefusal(svc.refresh(tablet.refresh_token, 'r'), 'REFRESH_TOKEN_INVALID', 401, 'explicitly_revoked');
      expect(audit.events.at(-1)).toMatchObject({ event_type: 'identity.session.revoked', payload: { reason: 'native_device_revoked', device_session_id: tablet.device_session_id, actor_device_session_id: phone.device_session_id } });
      const fromTablet = { sub: USER_A, tenant_id: TENANT, dsid: tablet.device_session_id };
      await expectRefusal(svc.listSessions(fromTablet, 'r'), 'INVALID_TOKEN', 401, 'device_session_revoked');
      await expectRefusal(svc.revokeSession(fromTablet, phone.device_session_id, 'r'), 'INVALID_TOKEN', 401, 'device_session_revoked');
      expect(store.sessions.get(phone.device_session_id)!.revoked_at).toBeNull();
    });
  });
});
