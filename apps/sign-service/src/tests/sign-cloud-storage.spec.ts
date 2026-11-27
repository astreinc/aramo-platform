import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';

import { type AuthContextType } from '@aramo/auth';
import { AramoError } from '@aramo/common';
import type { CloudConnectionRow, CloudOAuthStateRow, CloudOwner } from '@aramo/sign';
import { FEATURE_AVAILABILITY } from '@aramo/subscription';
import { describe, expect, it, vi } from 'vitest';

import { cloudCallbackUrl, cloudCredentials, cloudRedirectBase, offeredCloudProviders } from '../app/cloud-storage/cloud-storage.config.js';
import { CloudStorageService, CLOUD_STATE_TTL_MS } from '../app/cloud-storage/cloud-storage.service.js';
import { cloudTokenKeyAvailable, decryptCloudToken, encryptCloudToken } from '../app/cloud-storage/cloud-token-crypto.js';
import { SignFeatureGate } from '../app/sign-feature.gate.js';

// SIGN-FREE-PARITY-1 S6 (FP-R7) — cloud storage import and export in sign-service: dark per
// provider, tokens encrypted per user, single-use OAuth state, import through the normal
// upload, export from the executed copy, disconnect. Provider HTTP is a mocked fetch.

const TENANT = 'c6000000-0000-7000-8000-000000000001';
const USER = 'c6000000-0000-7000-8000-000000000002';
const OTHER = 'c6000000-0000-7000-8000-000000000003';
const ENV_ID = 'c6000000-0000-7000-8000-0000000000e1';
const AUTH = { sub: USER, tenant_id: TENANT, scopes: ['sign:envelope:create', 'sign:envelope:read'], consumer_type: 'sign' } as unknown as AuthContextType;
const NOW = new Date('2026-11-27T12:00:00.000Z');

const KEY = randomBytes(32).toString('base64');
const ENV: NodeJS.ProcessEnv = {
  SIGN_CLOUD_TOKEN_KEY: KEY,
  SIGN_CLOUD_REDIRECT_BASE_URL: 'https://sign.example.com',
  SIGN_CLOUD_GOOGLE_DRIVE_CLIENT_ID: 'g-id',
  SIGN_CLOUD_GOOGLE_DRIVE_CLIENT_SECRET: 'g-secret',
  SIGN_CLOUD_DROPBOX_CLIENT_ID: 'd-id',
  SIGN_CLOUD_DROPBOX_CLIENT_SECRET: 'd-secret',
  SIGN_CLOUD_BOX_CLIENT_ID: 'b-id',
  SIGN_CLOUD_BOX_CLIENT_SECRET: 'b-secret',
};
const ALL_ON = { ...FEATURE_AVAILABILITY, 'sign.cloud_google_drive': 'AVAILABLE', 'sign.cloud_onedrive': 'AVAILABLE', 'sign.cloud_dropbox': 'AVAILABLE', 'sign.cloud_box': 'AVAILABLE' } as const;

class FakeRepo {
  states: CloudOAuthStateRow[] = [];
  rows: CloudConnectionRow[] = [];
  async createState(row: Omit<CloudOAuthStateRow, 'id' | 'created_at' | 'consumed_at'>, now: Date) {
    this.states.push({ ...row, id: `s${this.states.length}`, created_at: now, consumed_at: null });
  }
  async consumeState(state_sha256: string, provider: string, now: Date) {
    const s = this.states.find((x) => x.state_sha256 === state_sha256 && x.provider === provider && x.consumed_at === null && x.expires_at > now);
    if (s === undefined) return null;
    s.consumed_at = now;
    return s;
  }
  async listConnections(o: CloudOwner) {
    return this.rows.filter((r) => r.tenant_id === o.tenant_id && r.user_id === o.user_id);
  }
  async getConnection(o: CloudOwner, provider: string) {
    return this.rows.find((r) => r.tenant_id === o.tenant_id && r.user_id === o.user_id && r.provider === provider) ?? null;
  }
  async upsertConnection(o: CloudOwner, provider: string, data: Omit<CloudConnectionRow, 'id' | 'tenant_id' | 'user_id' | 'provider' | 'created_at' | 'updated_at' | 'last_used_at'>, now: Date) {
    const have = await this.getConnection(o, provider);
    if (have !== null) Object.assign(have, data, { updated_at: now });
    else this.rows.push({ id: `c${this.rows.length}`, ...o, provider, ...data, created_at: now, updated_at: now, last_used_at: null });
    return (await this.getConnection(o, provider)) as CloudConnectionRow;
  }
  async updateTokens(o: CloudOwner, provider: string, t: { access_token_ciphertext: string; refresh_token_ciphertext?: string | null; access_token_expires_at: Date | null }) {
    const r = await this.getConnection(o, provider);
    if (r === null) return;
    r.access_token_ciphertext = t.access_token_ciphertext;
    r.access_token_expires_at = t.access_token_expires_at;
    if (t.refresh_token_ciphertext !== undefined) r.refresh_token_ciphertext = t.refresh_token_ciphertext;
  }
  async touch(o: CloudOwner, provider: string, now: Date) {
    const r = await this.getConnection(o, provider);
    if (r !== null) r.last_used_at = now;
  }
  async deleteConnection(o: CloudOwner, provider: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.tenant_id === o.tenant_id && r.user_id === o.user_id && r.provider === provider));
    return before - this.rows.length;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Route = (url: string, init?: RequestInit) => Response | undefined;
function fetchOf(...routes: Route[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    for (const r of routes) {
      const out = r(url, init);
      if (out !== undefined) return out;
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
  });
  return Object.assign(fn, { calls });
}

const PDF = Buffer.from('%PDF-1.7\n%%EOF');

function build(opts: { registry?: Record<string, string>; fetch?: ReturnType<typeof fetchOf>; env?: NodeJS.ProcessEnv; kind?: string; word?: boolean } = {}) {
  const repo = new FakeRepo();
  const envelopes = {
    upload: vi.fn(async () => ({ id: 'doc1', envelope_id: ENV_ID, title: 'Offer', ordinal: 0, byte_size: PDF.length, page_count: 1, pages: [], revision: 4 })),
    executed: vi.fn(async () => ({
      envelope_id: ENV_ID,
      documents: [{ envelope_document_id: 'd1', title: 'Offer', executed_sha256: 'x', byte_size: PDF.length, executed_base64: PDF.toString('base64') }],
      certificate: { certificate_base64: PDF.toString('base64') },
    })),
  };
  const context = { tenantKind: vi.fn(async () => opts.kind ?? 'PERSONAL'), assertCanAuthor: vi.fn(async () => undefined) };
  const gate = new SignFeatureGate((opts.registry ?? ALL_ON) as never);
  const f = opts.fetch ?? fetchOf();
  const word = { enabled: opts.word === true, convert: vi.fn() };
  const svc = new CloudStorageService(repo as never, envelopes as never, context as never, gate, word as never, f, opts.env ?? ENV);
  return { svc, repo, envelopes, context, fetch: f };
}

async function connected(repo: FakeRepo, provider: string, over: Partial<CloudConnectionRow> = {}) {
  await repo.upsertConnection(
    { tenant_id: TENANT, user_id: USER },
    provider,
    {
      account_label: 'me@example.com',
      access_token_ciphertext: encryptCloudToken('AT', ENV),
      refresh_token_ciphertext: encryptCloudToken('RT', ENV),
      // A live token whatever the wall clock: the service checks expiry against the real time,
      // so a NOW-relative expiry went stale an hour after NOW (CI failure 2026-11-27 13:00Z).
      access_token_expires_at: new Date('2099-01-01T00:00:00.000Z'),
      scopes: 'x',
      ...over,
    },
    NOW,
  );
}

async function refusalOf(p: Promise<unknown>): Promise<AramoError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AramoError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('cloud token crypto', () => {
  it('round-trips under SIGN_CLOUD_TOKEN_KEY and refuses without it (fail closed)', () => {
    const c = encryptCloudToken('secret-token', ENV);
    expect(c).not.toContain('secret-token');
    expect(c.startsWith('v1.')).toBe(true);
    expect(decryptCloudToken(c, ENV)).toBe('secret-token');
    expect(cloudTokenKeyAvailable({})).toBe(false);
    expect(cloudTokenKeyAvailable({ SIGN_CLOUD_TOKEN_KEY: Buffer.alloc(16).toString('base64') })).toBe(false);
    expect(() => encryptCloudToken('x', {})).toThrow();
    expect(() => decryptCloudToken(c, { SIGN_CLOUD_TOKEN_KEY: randomBytes(32).toString('base64') })).toThrow();
  });
});

describe('cloud storage availability (dark per provider)', () => {
  it('the shipped registry offers no provider, even fully configured', () => {
    expect(FEATURE_AVAILABILITY['sign.cloud_google_drive']).toBe('NOT_AVAILABLE');
    expect(FEATURE_AVAILABILITY['sign.cloud_onedrive']).toBe('NOT_AVAILABLE');
    expect(FEATURE_AVAILABILITY['sign.cloud_dropbox']).toBe('NOT_AVAILABLE');
    expect(FEATURE_AVAILABILITY['sign.cloud_box']).toBe('NOT_AVAILABLE');
    const shipped = new SignFeatureGate();
    expect(offeredCloudProviders((k) => shipped.isAvailable(k), ENV)).toEqual([]);
  });

  it('a provider needs its launch key, its client id + secret, the token key and a redirect base', () => {
    const on = new SignFeatureGate(ALL_ON as never);
    const is = (k: string) => on.isAvailable(k);
    // OneDrive has no client configured in ENV.
    expect(offeredCloudProviders(is, ENV)).toEqual(['google_drive', 'dropbox', 'box']);
    expect(offeredCloudProviders(is, { ...ENV, SIGN_CLOUD_TOKEN_KEY: '' })).toEqual([]);
    expect(offeredCloudProviders(is, { ...ENV, SIGN_CLOUD_REDIRECT_BASE_URL: 'http://sign.example.com' })).toEqual([]);
    expect(offeredCloudProviders(is, { ...ENV, SIGN_CLOUD_BOX_CLIENT_SECRET: ' ' })).toEqual(['google_drive', 'dropbox']);
  });

  it('the redirect base falls back to ARAMO_SIGN_BASE_URL and allows http only on localhost', () => {
    expect(cloudRedirectBase({ ARAMO_SIGN_BASE_URL: 'https://sign.aramo.ai/' })).toBe('https://sign.aramo.ai');
    expect(cloudRedirectBase({ SIGN_WEB_BASE_URL: 'http://localhost:4210' })).toBe('http://localhost:4210');
    expect(cloudRedirectBase({})).toBeNull();
    expect(cloudCallbackUrl('https://s', 'box')).toBe('https://s/v1/sign/sender/cloud-storage/box/callback');
    expect(cloudCredentials('onedrive', ENV)).toBeNull();
  });

  it('every route refuses a provider that is not offered (403, the launch key named)', async () => {
    const { svc } = build({ registry: FEATURE_AVAILABILITY as never });
    const e = await refusalOf(svc.connect(AUTH, 'box', {}, 'r'));
    expect(e.statusCode).toBe(403);
    expect(e.code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
    expect((e.context.details as { feature_key?: string }).feature_key).toBe('sign.cloud_box');
    expect((await refusalOf(svc.items(AUTH, 'box', {}, 'r'))).statusCode).toBe(403);
    expect((await refusalOf(svc.importFile(AUTH, ENV_ID, { provider: 'box', file_id: 'f' }, 'r'))).statusCode).toBe(403);
    expect((await refusalOf(svc.exportExecuted(AUTH, ENV_ID, { provider: 'box' }, 'r'))).statusCode).toBe(403);
    expect((await svc.list(AUTH)).providers).toEqual([]);
  });

  it('an unknown provider is 404', async () => {
    const { svc } = build();
    expect((await refusalOf(svc.connect(AUTH, 'ftp', {}, 'r'))).statusCode).toBe(404);
  });
});

describe('connect and callback', () => {
  it('connect returns the provider URL and stores only sha256(state) and an encrypted verifier', async () => {
    const { svc, repo } = build();
    const { authorize_url } = await svc.connect(AUTH, 'google_drive', {}, 'r', NOW);
    const u = new URL(authorize_url);
    expect(u.host).toBe('accounts.google.com');
    expect(u.searchParams.get('redirect_uri')).toBe('https://sign.example.com/v1/sign/sender/cloud-storage/google_drive/callback');
    const state = u.searchParams.get('state') ?? '';
    const [row] = repo.states;
    expect(row?.state_sha256).toBe(createHash('sha256').update(state).digest('hex'));
    expect(row?.state_sha256).not.toBe(state);
    expect(row?.code_verifier_ciphertext.startsWith('v1.')).toBe(true);
    expect(row?.expires_at.getTime()).toBe(NOW.getTime() + CLOUD_STATE_TTL_MS);
    expect(row?.return_path).toBe('/personal/settings/storage');
    expect(row?.client).toBe('web');
  });

  it('a web return path must stay inside the caller’s workspace', async () => {
    const { svc } = build({ kind: 'BUSINESS' });
    await expect(svc.connect(AUTH, 'box', { return_path: '/sign/envelopes/abc/edit' }, 'r', NOW)).resolves.toBeDefined();
    for (const bad of ['/personal/settings', 'https://evil.example', '//evil.example', '/sign/x?y=1', '/sign/../x', 7]) {
      expect((await refusalOf(svc.connect(AUTH, 'box', { return_path: bad }, 'r', NOW))).statusCode).toBe(400);
    }
    expect((await refusalOf(svc.connect(AUTH, 'box', { client: 'desktop' }, 'r', NOW))).statusCode).toBe(400);
  });

  it('callback exchanges the code, stores encrypted tokens for the state’s user and returns to the page', async () => {
    const f = fetchOf(
      (url, init) => (url === 'https://oauth2.googleapis.com/token' ? (new URLSearchParams(String(init?.body)).get('code_verifier') ? json({ access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 3600, scope: 's' }) : json({}, 400)) : undefined),
      (url) => (url.startsWith('https://www.googleapis.com/drive/v3/about') ? json({ user: { emailAddress: 'me@gmail.com' } }) : undefined),
    );
    const { svc, repo } = build({ fetch: f });
    const state = new URL((await svc.connect(AUTH, 'google_drive', { return_path: '/personal/envelopes/e1/edit' }, 'r', NOW)).authorize_url).searchParams.get('state');
    const to = await svc.callback('google_drive', { code: 'CODE', state }, NOW);
    expect(to).toBe('https://sign.example.com/personal/envelopes/e1/edit?cloud_storage=connected&provider=google_drive');
    const [row] = repo.rows;
    expect(row?.user_id).toBe(USER);
    expect(row?.account_label).toBe('me@gmail.com');
    expect(row?.access_token_ciphertext).not.toContain('ACCESS');
    expect(decryptCloudToken(row?.access_token_ciphertext ?? '', ENV)).toBe('ACCESS');
    expect(decryptCloudToken(row?.refresh_token_ciphertext ?? '', ENV)).toBe('REFRESH');
    // Single use: the same state again goes nowhere.
    expect(await svc.callback('google_drive', { code: 'CODE', state }, NOW)).toBe('https://sign.example.com/?cloud_storage=failed');
  });

  it('the app gets its scheme back; a denied consent is "cancelled"; an expired state fails', async () => {
    const { svc } = build();
    const s1 = new URL((await svc.connect(AUTH, 'dropbox', { client: 'app' }, 'r', NOW)).authorize_url).searchParams.get('state');
    expect(await svc.callback('dropbox', { error: 'access_denied', state: s1 }, NOW)).toBe('aramosign://cloud-storage?cloud_storage=cancelled&provider=dropbox');
    const s2 = new URL((await svc.connect(AUTH, 'dropbox', {}, 'r', NOW)).authorize_url).searchParams.get('state');
    expect(await svc.callback('dropbox', { code: 'c', state: s2 }, new Date(NOW.getTime() + CLOUD_STATE_TTL_MS + 1))).toBe('https://sign.example.com/?cloud_storage=failed');
  });

  it('a state is bound to its provider; a failed exchange stores nothing', async () => {
    const f = fetchOf((url) => (url === 'https://api.box.com/oauth2/token' ? json({ error: 'invalid_grant' }, 400) : undefined));
    const { svc, repo } = build({ fetch: f });
    const s = new URL((await svc.connect(AUTH, 'box', {}, 'r', NOW)).authorize_url).searchParams.get('state');
    expect(await svc.callback('dropbox', { code: 'c', state: s }, NOW)).toContain('cloud_storage=failed');
    const s2 = new URL((await svc.connect(AUTH, 'box', {}, 'r', NOW)).authorize_url).searchParams.get('state');
    expect(await svc.callback('box', { code: 'c', state: s2 }, NOW)).toBe('https://sign.example.com/personal/settings/storage?cloud_storage=failed&provider=box');
    expect(repo.rows).toHaveLength(0);
  });
});

describe('list and disconnect', () => {
  it('lists offered providers with the caller’s own connections only', async () => {
    const { svc, repo } = build();
    await connected(repo, 'box');
    repo.rows.push({ ...(repo.rows[0] as CloudConnectionRow), id: 'other', user_id: OTHER, provider: 'dropbox' });
    const { providers } = await svc.list(AUTH);
    expect(providers.map((p) => [p.provider, p.connected, p.folder_choice])).toEqual([
      ['google_drive', false, false],
      ['dropbox', false, true],
      ['box', true, true],
    ]);
    expect(providers[2]?.account_label).toBe('me@example.com');
  });

  it('disconnect revokes at the provider and deletes the tokens; a provider switched off can still be disconnected', async () => {
    const f = fetchOf((url) => (url === 'https://api.box.com/oauth2/revoke' ? new Response(null, { status: 200 }) : undefined));
    const { svc, repo } = build({ fetch: f, registry: FEATURE_AVAILABILITY as never });
    await connected(repo, 'box');
    await svc.disconnect(AUTH, 'box', 'r');
    expect(repo.rows).toHaveLength(0);
    expect(new URLSearchParams(String(f.calls[0]?.init?.body)).get('token')).toBe('RT');
    // Nothing connected: still fine (idempotent).
    await expect(svc.disconnect(AUTH, 'box', 'r')).resolves.toBeUndefined();
  });

  it('a failed revoke still deletes the tokens', async () => {
    const f = fetchOf(() => new Response(null, { status: 500 }));
    const { svc, repo } = build({ fetch: f });
    await connected(repo, 'google_drive');
    await svc.disconnect(AUTH, 'google_drive', 'r');
    expect(repo.rows).toHaveLength(0);
  });
});

describe('browse', () => {
  it('lists PDFs only unless Word conversion is on and the client asks', async () => {
    const f = fetchOf((url) => (url.startsWith('https://api.box.com/2.0/folders/0/items') ? json({ entries: [{ type: 'file', id: '1', name: 'a.pdf' }, { type: 'file', id: '2', name: 'b.docx' }] }) : undefined));
    const { svc, repo } = build({ fetch: f, word: true });
    await connected(repo, 'box');
    expect((await svc.items(AUTH, 'box', {}, 'r')).items.map((i) => i.id)).toEqual(['1']);
    expect((await svc.items(AUTH, 'box', { include_word: '1' }, 'r')).items.map((i) => i.id)).toEqual(['1', '2']);
    const off = build({ fetch: f, word: false });
    await connected(off.repo, 'box');
    expect((await off.svc.items(AUTH, 'box', { include_word: '1' }, 'r')).items.map((i) => i.id)).toEqual(['1']);
  });

  it('not connected is 409 cloud_not_connected; a long query is 400', async () => {
    const { svc } = build();
    const e = await refusalOf(svc.items(AUTH, 'box', {}, 'r'));
    expect(e.statusCode).toBe(409);
    expect((e.context.details as { reason?: string }).reason).toBe('cloud_not_connected');
    expect((await refusalOf(svc.items(AUTH, 'box', { q: 'x'.repeat(101) }, 'r'))).statusCode).toBe(400);
  });

  it('refreshes an expired access token first and stores the new one', async () => {
    const f = fetchOf(
      (url) => (url === 'https://api.dropboxapi.com/oauth2/token' ? json({ access_token: 'AT2', expires_in: 14400 }) : undefined),
      (url, init) => (url === 'https://api.dropboxapi.com/2/files/list_folder' ? (new Headers(init?.headers).get('authorization') === 'Bearer AT2' ? json({ entries: [], has_more: false }) : json({}, 401)) : undefined),
    );
    const { svc, repo } = build({ fetch: f });
    await connected(repo, 'dropbox', { access_token_expires_at: new Date(NOW.getTime() - 1000) });
    await svc.items(AUTH, 'dropbox', {}, 'r');
    expect(decryptCloudToken(repo.rows[0]?.access_token_ciphertext ?? '', ENV)).toBe('AT2');
    expect(decryptCloudToken(repo.rows[0]?.refresh_token_ciphertext ?? '', ENV)).toBe('RT');
  });

  it('a refused refresh deletes the useless tokens and asks to connect again', async () => {
    const f = fetchOf(
      (url) => (url.startsWith('https://api.box.com/2.0/folders/') ? json({}, 401) : undefined),
      (url) => (url === 'https://api.box.com/oauth2/token' ? json({ error: 'invalid_grant' }, 400) : undefined),
    );
    const { svc, repo } = build({ fetch: f });
    await connected(repo, 'box');
    const e = await refusalOf(svc.items(AUTH, 'box', {}, 'r'));
    expect((e.context.details as { reason?: string }).reason).toBe('cloud_reconnect_required');
    expect(repo.rows).toHaveLength(0);
  });
});

describe('import', () => {
  it('fetches the file server-side and hands it to the normal upload (same gates, If-Match, idempotency)', async () => {
    const f = fetchOf(
      (url) => (url.startsWith('https://www.googleapis.com/drive/v3/files/F1?fields') ? json({ id: 'F1', name: 'Offer letter.pdf', mimeType: 'application/pdf', size: String(PDF.length) }) : undefined),
      (url) => (url === 'https://www.googleapis.com/drive/v3/files/F1?alt=media' ? new Response(PDF) : undefined),
    );
    const { svc, repo, envelopes, context } = build({ fetch: f });
    await connected(repo, 'google_drive');
    const out = await svc.importFile(AUTH, ENV_ID, { provider: 'google_drive', file_id: 'F1' }, 'r', { ifMatch: '"x.3"', idempotencyKey: 'k1' });
    expect(out.revision).toBe(4);
    expect(context.assertCanAuthor).toHaveBeenCalled();
    expect(envelopes.upload).toHaveBeenCalledWith(AUTH, ENV_ID, { filename: 'Offer letter.pdf', title: 'Offer letter', content_base64: PDF.toString('base64') }, 'r', { ifMatch: '"x.3"', idempotencyKey: 'k1' });
  });

  it('refuses a file over 25 MB from its declared size, before downloading', async () => {
    const f = fetchOf((url) => (url.includes('/files/F2?fields') ? json({ id: 'F2', name: 'big.pdf', mimeType: 'application/pdf', size: String(26 * 1024 * 1024) }) : undefined));
    const { svc, repo, envelopes } = build({ fetch: f });
    await connected(repo, 'google_drive');
    const e = await refusalOf(svc.importFile(AUTH, ENV_ID, { provider: 'google_drive', file_id: 'F2' }, 'r'));
    expect(e.statusCode).toBe(413);
    expect((e.context.details as { reason?: string }).reason).toBe('cloud_file_too_large');
    expect(f.calls).toHaveLength(1);
    expect(envelopes.upload).not.toHaveBeenCalled();
  });

  it('refuses a folder and a missing file id', async () => {
    const f = fetchOf((url) => (url.includes('/files/D?fields') ? json({ id: 'D', name: 'Docs', mimeType: 'application/vnd.google-apps.folder' }) : undefined));
    const { svc, repo } = build({ fetch: f });
    await connected(repo, 'google_drive');
    expect((await refusalOf(svc.importFile(AUTH, ENV_ID, { provider: 'google_drive', file_id: 'D' }, 'r'))).context.details).toMatchObject({ reason: 'cloud_not_a_file' });
    expect((await refusalOf(svc.importFile(AUTH, ENV_ID, { provider: 'google_drive' }, 'r'))).statusCode).toBe(400);
  });

  it('a provider outage is 502 cloud_provider_unavailable', async () => {
    const f = fetchOf(() => new Response('', { status: 503 }));
    const { svc, repo } = build({ fetch: f });
    await connected(repo, 'box');
    const e = await refusalOf(svc.importFile(AUTH, ENV_ID, { provider: 'box', file_id: '1' }, 'r'));
    expect(e.statusCode).toBe(502);
    expect((e.context.details as { reason?: string }).reason).toBe('cloud_provider_unavailable');
  });
});

describe('export', () => {
  it('saves the executed PDF to the "Aramo Sign" folder by default', async () => {
    const f = fetchOf(
      (url, init) => (url === 'https://api.box.com/2.0/folders?fields=id,name' && init?.method === 'POST' ? json({ type: 'folder', id: '77', name: 'Aramo Sign' }, 201) : undefined),
      (url) => (url.startsWith('https://upload.box.com/') ? json({ entries: [{ type: 'file', id: '9', name: 'Offer (signed).pdf' }] }, 201) : undefined),
    );
    const { svc, repo, envelopes } = build({ fetch: f });
    await connected(repo, 'box');
    const out = await svc.exportExecuted(AUTH, ENV_ID, { provider: 'box' }, 'r');
    expect(envelopes.executed).toHaveBeenCalledWith(AUTH, ENV_ID, 'r');
    expect(out).toEqual({ provider: 'box', folder: { id: '77', name: 'Aramo Sign' }, saved: [{ name: 'Offer (signed).pdf', web_url: 'https://app.box.com/file/9' }] });
  });

  it('the executed rule refuses first (not completed / purged): nothing is sent to the provider', async () => {
    const f = fetchOf();
    const { svc, repo, envelopes } = build({ fetch: f });
    await connected(repo, 'box');
    envelopes.executed.mockRejectedValueOnce(new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'not completed', 409, { requestId: 'r' }));
    expect((await refusalOf(svc.exportExecuted(AUTH, ENV_ID, { provider: 'box' }, 'r'))).statusCode).toBe(409);
    expect(f.calls).toHaveLength(0);
  });

  it('Google Drive refuses a chosen folder (drive.file saves only to the app folder)', async () => {
    const { svc, repo } = build();
    await connected(repo, 'google_drive');
    const e = await refusalOf(svc.exportExecuted(AUTH, ENV_ID, { provider: 'google_drive', folder_id: 'abc' }, 'r'));
    expect((e.context.details as { reason?: string }).reason).toBe('cloud_folder_not_writable');
  });

  it('a chosen folder is used, with the certificate when asked', async () => {
    const f = fetchOf(
      (url) => (url === 'https://api.box.com/2.0/folders/55?fields=id,type,name' ? json({ type: 'folder', id: '55', name: 'HR' }) : undefined),
      (url) => (url.startsWith('https://upload.box.com/') ? json({ entries: [{ type: 'file', id: '1', name: 'x.pdf' }] }, 201) : undefined),
    );
    const { svc, repo } = build({ fetch: f });
    await connected(repo, 'box');
    const out = await svc.exportExecuted(AUTH, ENV_ID, { provider: 'box', folder_id: '55', include_certificate: true }, 'r');
    expect(out.folder).toEqual({ id: '55', name: 'HR' });
    expect(out.saved).toHaveLength(2);
  });
});
