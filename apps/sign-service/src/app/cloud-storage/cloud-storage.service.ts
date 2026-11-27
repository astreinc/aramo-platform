import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { SignCloudStorageRepository, type CloudOwner } from '@aramo/sign';
import { CLOUD_EXPORT_FOLDER, CLOUD_PROVIDER_FEATURE_KEYS, CLOUD_PROVIDER_LABELS, MAX_PDF_BYTES, MAX_WORD_BYTES, isCloudProvider, signedCopyName, titleFromFilename, type CloudProviderId } from '@aramo/sign-client';
import {
  CloudProviderError,
  OAUTH_SPECS,
  authorizeUrl,
  cloudDriveClient,
  exchangeCode,
  extensionOf,
  randomToken,
  refreshAccessToken,
  revokeGrant,
  sha256Hex,
  type CloudDriveClient,
  type CloudItem,
  type FetchLike,
  type TokenSet,
} from '@aramo/sign-cloud-storage';

import { SenderContextService } from '../sender/sender-context.service.js';
import { SenderEnvelopeService } from '../sender/sender-envelope.service.js';
import { SignFeatureGate } from '../sign-feature.gate.js';
import { WORD_CONVERSION_PORT, type WordConversionPort } from '../word-conversion/word-conversion.port.js';

import { CLOUD_APP_RETURN_URL, cloudCallbackUrl, cloudCredentials, cloudProviderOffered, cloudRedirectBase, offeredCloudProviders } from './cloud-storage.config.js';
import { decryptCloudToken, encryptCloudToken } from './cloud-token-crypto.js';

// SIGN-FREE-PARITY-1 S6 (FP-R7) — cloud storage import and export for the signed-in user.
//
//   connect     POST …/cloud-storage/:provider/connect  → the provider's authorize URL. A
//               pending state row keeps sha256(state), the encrypted PKCE verifier and where
//               to return; it lives 10 minutes and is used once.
//   callback    GET  …/cloud-storage/:provider/callback  (no session: the single-use state is
//               the authority) → tokens exchanged server-side, encrypted, stored per
//               (tenant, user, provider) → 302 back to the Sign web app or the Aramo Sign app.
//   browse      folders, PDFs (and Word files when the upload converts Word and the client asks).
//   import      the file's bytes are fetched server-side and go through the SAME upload as a
//               file from the device (SenderEnvelopeService.upload: author check, revision,
//               idempotency, Word conversion, SafePdfPipeline, page measure, storage
//               reservation, owned source). Nothing here re-implements a gate.
//   export      the executed PDFs (SenderEnvelopeService.executed: a COMPLETED, unpurged
//               envelope, downloadStateRefusal) are added to the chosen folder, or to
//               "Aramo Sign"; an existing file is never replaced.
//   disconnect  revoke at the provider (best effort) and delete the tokens.
// Every route needs the provider offered (cloud-storage.config.ts); otherwise 403
// ESIGN_FEATURE_NOT_AVAILABLE with the provider's launch key.

export const CLOUD_STORAGE_FETCH = 'CLOUD_STORAGE_FETCH';
export const CLOUD_STORAGE_ENV = 'CLOUD_STORAGE_ENV';

export const CLOUD_STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
const MAX_QUERY = 100;
const MAX_ID = 512;
const MAX_CURSOR = 4096;
// A return path inside the user's own workspace: /sign/… or /personal/…, no query, no "//",
// no "." or ".." segment.
const RETURN_PATH = /^\/(sign|personal)(\/(?!\.+(\/|$))[A-Za-z0-9._~-]+)*\/?$/;

export type CloudClientKind = 'web' | 'app';

export interface CloudProviderView {
  provider: CloudProviderId;
  label: string;
  connected: boolean;
  account_label: string | null;
  connected_at: string | null;
  /** Saving to a folder the user chooses works (false on Google Drive). */
  folder_choice: boolean;
}

function refusal(code: 'INVALID_REQUEST' | 'VALIDATION_ERROR' | 'NOT_FOUND', status: number, message: string, reason: string, requestId: string, extra: Record<string, unknown> = {}): AramoError {
  return new AramoError(code, message, status, { requestId, details: { reason, ...extra } });
}

@Injectable()
export class CloudStorageService {
  private readonly log = new Logger('CloudStorage');
  private readonly fetchFn: FetchLike;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly repo: SignCloudStorageRepository,
    private readonly envelopes: SenderEnvelopeService,
    private readonly context: SenderContextService,
    @Optional() private readonly features?: SignFeatureGate,
    @Optional() @Inject(WORD_CONVERSION_PORT) private readonly wordConversion?: WordConversionPort,
    @Optional() @Inject(CLOUD_STORAGE_FETCH) fetchFn?: FetchLike,
    @Optional() @Inject(CLOUD_STORAGE_ENV) env?: NodeJS.ProcessEnv,
  ) {
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init));
    this.env = env ?? process.env;
  }

  private gate(): SignFeatureGate {
    return this.features ?? new SignFeatureGate();
  }

  /** The providers this deployment offers (the sender context's `cloud_storage`). */
  offered(): CloudProviderId[] {
    return offeredCloudProviders((k) => this.gate().isAvailable(k), this.env);
  }

  private owner(auth: AuthContextType): CloudOwner {
    return { tenant_id: auth.tenant_id, user_id: auth.sub };
  }

  private provider(raw: unknown, requestId: string): CloudProviderId {
    if (!isCloudProvider(raw)) throw refusal('NOT_FOUND', 404, 'Unknown storage provider', 'cloud_provider_unknown', requestId);
    if (!cloudProviderOffered(raw, (k) => this.gate().isAvailable(k), this.env)) {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'This feature is not available in Aramo Sign yet', 403, { requestId, details: { feature_key: CLOUD_PROVIDER_FEATURE_KEYS[raw] } });
    }
    return raw;
  }

  // ── connections ──

  async list(auth: AuthContextType): Promise<{ providers: CloudProviderView[] }> {
    const offered = this.offered();
    const rows = offered.length === 0 ? [] : await this.repo.listConnections(this.owner(auth));
    return {
      providers: offered.map((p) => {
        const row = rows.find((r) => r.provider === p);
        return {
          provider: p,
          label: CLOUD_PROVIDER_LABELS[p],
          connected: row !== undefined,
          account_label: row?.account_label ?? null,
          connected_at: row?.created_at.toISOString() ?? null,
          folder_choice: OAUTH_SPECS[p].export_folder_choice,
        };
      }),
    };
  }

  async connect(auth: AuthContextType, rawProvider: string, body: { client?: unknown; return_path?: unknown } | undefined, requestId: string, now: Date = new Date()): Promise<{ authorize_url: string }> {
    const provider = this.provider(rawProvider, requestId);
    const client: CloudClientKind = body?.client === 'app' ? 'app' : 'web';
    if (body?.client !== undefined && body.client !== 'web' && body.client !== 'app') {
      throw refusal('VALIDATION_ERROR', 400, 'client must be web or app', 'invalid_client', requestId, { field: 'client' });
    }
    // The web returns to a page of the user's own workspace (default: Settings → Connected
    // storage); the app returns to its URL scheme.
    let return_path: string | null = null;
    if (client === 'web') {
      const workspace = (await this.context.tenantKind(auth.tenant_id, requestId)) === 'BUSINESS' ? 'sign' : 'personal';
      const p = body?.return_path ?? `/${workspace}/settings/storage`;
      if (typeof p !== 'string' || p.length > 200 || !RETURN_PATH.test(p) || !(p === `/${workspace}` || p.startsWith(`/${workspace}/`))) {
        throw refusal('VALIDATION_ERROR', 400, 'return_path must be a page of this workspace', 'invalid_return_path', requestId, { field: 'return_path' });
      }
      return_path = p;
    }
    const creds = cloudCredentials(provider, this.env);
    const base = cloudRedirectBase(this.env);
    if (creds === null || base === null) throw new Error('cloud provider offered without its configuration');
    const state = randomToken();
    const code_verifier = randomToken();
    await this.repo.createState(
      {
        tenant_id: auth.tenant_id,
        user_id: auth.sub,
        provider,
        state_sha256: sha256Hex(state),
        code_verifier_ciphertext: encryptCloudToken(code_verifier, this.env),
        client,
        return_path,
        expires_at: new Date(now.getTime() + CLOUD_STATE_TTL_MS),
      },
      now,
    );
    return { authorize_url: authorizeUrl(provider, creds, { redirect_uri: cloudCallbackUrl(base, provider), state, code_verifier }) };
  }

  /**
   * The provider's redirect. Never throws: always answers with the address to send the
   * browser to, carrying cloud_storage=connected|cancelled|failed and the provider.
   */
  async callback(rawProvider: string, query: { code?: unknown; state?: unknown; error?: unknown }, now: Date = new Date()): Promise<string> {
    const base = cloudRedirectBase(this.env) ?? '';
    const provider = isCloudProvider(rawProvider) ? rawProvider : null;
    const fallback = `${base}/?cloud_storage=failed`;
    if (provider === null || typeof query.state !== 'string' || query.state.length === 0 || query.state.length > 512) return fallback;
    const pending = await this.repo.consumeState(sha256Hex(query.state), provider, now).catch(() => null);
    if (pending === null) return fallback;
    const back = (status: 'connected' | 'cancelled' | 'failed'): string => {
      const q = `cloud_storage=${status}&provider=${provider}`;
      if (pending.client === 'app') return `${CLOUD_APP_RETURN_URL}?${q}`;
      return `${base}${pending.return_path ?? '/'}?${q}`;
    };
    if (typeof query.error === 'string' && query.error.length > 0) return back('cancelled');
    if (typeof query.code !== 'string' || query.code.length === 0 || query.code.length > 4096) return back('failed');
    const creds = cloudCredentials(provider, this.env);
    if (creds === null || base === '' || !cloudProviderOffered(provider, (k) => this.gate().isAvailable(k), this.env)) return back('failed');
    try {
      const code_verifier = decryptCloudToken(pending.code_verifier_ciphertext, this.env);
      const tokens = await exchangeCode(provider, creds, { code: query.code, redirect_uri: cloudCallbackUrl(base, provider), code_verifier }, this.fetchFn, now);
      const account = await cloudDriveClient(provider, tokens.access_token, this.fetchFn)
        .account()
        .catch(() => ({ label: null }));
      await this.repo.upsertConnection(
        { tenant_id: pending.tenant_id, user_id: pending.user_id },
        provider,
        {
          account_label: account.label === null ? null : account.label.slice(0, 320),
          access_token_ciphertext: encryptCloudToken(tokens.access_token, this.env),
          refresh_token_ciphertext: tokens.refresh_token === null ? null : encryptCloudToken(tokens.refresh_token, this.env),
          access_token_expires_at: tokens.expires_at,
          scopes: tokens.scope ?? OAUTH_SPECS[provider].scopes.join(' '),
        },
        now,
      );
      return back('connected');
    } catch (e) {
      this.log.warn(`cloud storage connect failed (${provider}): ${(e as Error).name}`);
      return back('failed');
    }
  }

  async disconnect(auth: AuthContextType, rawProvider: string, requestId: string): Promise<void> {
    // Disconnect works even when the provider was switched off since: the user can always
    // remove their tokens. Only an unknown provider is refused.
    if (!isCloudProvider(rawProvider)) throw refusal('NOT_FOUND', 404, 'Unknown storage provider', 'cloud_provider_unknown', requestId);
    const owner = this.owner(auth);
    const row = await this.repo.getConnection(owner, rawProvider);
    if (row === null) return;
    const creds = cloudCredentials(rawProvider, this.env);
    if (creds !== null) {
      try {
        const access_token = decryptCloudToken(row.access_token_ciphertext, this.env);
        const refresh_token = row.refresh_token_ciphertext === null ? null : decryptCloudToken(row.refresh_token_ciphertext, this.env);
        await revokeGrant(rawProvider, creds, { access_token, refresh_token }, this.fetchFn);
      } catch {
        // Best effort: the tokens are deleted below either way.
      }
    }
    await this.repo.deleteConnection(owner, rawProvider);
  }

  // ── an authorized client (refreshing the access token when it is due) ──

  private async withClient<T>(auth: AuthContextType, provider: CloudProviderId, requestId: string, fn: (c: CloudDriveClient) => Promise<T>, now: Date = new Date()): Promise<T> {
    const owner = this.owner(auth);
    const row = await this.repo.getConnection(owner, provider);
    if (row === null) throw refusal('INVALID_REQUEST', 409, `Connect ${CLOUD_PROVIDER_LABELS[provider]} first`, 'cloud_not_connected', requestId, { provider });
    let access: string;
    let refresh: string | null;
    try {
      access = decryptCloudToken(row.access_token_ciphertext, this.env);
      refresh = row.refresh_token_ciphertext === null ? null : decryptCloudToken(row.refresh_token_ciphertext, this.env);
    } catch {
      await this.repo.deleteConnection(owner, provider);
      throw this.reconnect(provider, requestId);
    }
    const doRefresh = async (): Promise<string> => {
      const creds = cloudCredentials(provider, this.env);
      if (refresh === null || creds === null) throw new CloudProviderError('unauthorized', null, 'no refresh token');
      const t: TokenSet = await refreshAccessToken(provider, creds, refresh, this.fetchFn, now);
      await this.repo.updateTokens(
        owner,
        provider,
        {
          access_token_ciphertext: encryptCloudToken(t.access_token, this.env),
          ...(t.refresh_token !== null ? { refresh_token_ciphertext: encryptCloudToken(t.refresh_token, this.env) } : {}),
          access_token_expires_at: t.expires_at,
        },
        now,
      );
      if (t.refresh_token !== null) refresh = t.refresh_token;
      return t.access_token;
    };
    try {
      let refreshed = false;
      if (row.access_token_expires_at !== null && row.access_token_expires_at.getTime() - REFRESH_SKEW_MS <= now.getTime()) {
        access = await doRefresh();
        refreshed = true;
      }
      let out: T;
      try {
        out = await fn(cloudDriveClient(provider, access, this.fetchFn));
      } catch (e) {
        if (!(e instanceof CloudProviderError) || e.kind !== 'unauthorized' || refreshed) throw e;
        out = await fn(cloudDriveClient(provider, await doRefresh(), this.fetchFn));
      }
      await this.repo.touch(owner, provider, now).catch(() => undefined);
      return out;
    } catch (e) {
      if (e instanceof CloudProviderError) {
        if (e.kind === 'unauthorized') {
          // The grant is gone (revoked at the provider, expired): the stored tokens are useless.
          await this.repo.deleteConnection(owner, provider).catch(() => undefined);
          throw this.reconnect(provider, requestId);
        }
        throw this.providerHttp(e, requestId);
      }
      throw e;
    }
  }

  private reconnect(provider: CloudProviderId, requestId: string): AramoError {
    return refusal('INVALID_REQUEST', 409, `Connect ${CLOUD_PROVIDER_LABELS[provider]} again`, 'cloud_reconnect_required', requestId, { provider });
  }

  private providerHttp(e: CloudProviderError, requestId: string): AramoError {
    if (e.kind === 'not_found') return refusal('NOT_FOUND', 404, 'The file or folder was not found', 'cloud_file_not_found', requestId);
    if (e.kind === 'too_large') return refusal('VALIDATION_ERROR', 413, 'The file is larger than 25 MB', 'cloud_file_too_large', requestId);
    if (e.kind === 'forbidden') return refusal('INVALID_REQUEST', 409, 'The storage provider refused this folder', 'cloud_folder_not_writable', requestId);
    return new AramoError('INTERNAL_ERROR', 'The storage provider did not answer', 502, { requestId, details: { reason: 'cloud_provider_unavailable' } });
  }

  private wordOffered(): boolean {
    return this.wordConversion?.enabled === true;
  }

  // ── browse ──

  async items(
    auth: AuthContextType,
    rawProvider: string,
    q: { folder_id?: unknown; q?: unknown; cursor?: unknown; folders?: unknown; include_word?: unknown },
    requestId: string,
  ): Promise<{ items: CloudItem[]; next_cursor: string | null }> {
    const provider = this.provider(rawProvider, requestId);
    const text = (v: unknown, max: number, field: string): string | null => {
      if (v === undefined || v === null || v === '') return null;
      if (typeof v !== 'string' || v.length > max) throw refusal('VALIDATION_ERROR', 400, `${field} is invalid`, 'invalid_query', requestId, { field });
      return v;
    };
    const query = text(q.q, MAX_QUERY, 'q')?.trim() || null;
    const folder_id = text(q.folder_id, MAX_ID, 'folder_id');
    const cursor = text(q.cursor, MAX_CURSOR, 'cursor');
    const folders_only = q.folders === '1' || q.folders === 'true';
    // Word only when the upload converts it AND the client says it uploads Word (the web keeps
    // PDF only: C4 parity record).
    const word = (q.include_word === '1' || q.include_word === 'true') && this.wordOffered();
    return this.withClient(auth, provider, requestId, (c) => c.list({ folder_id, query, cursor, folders_only, extensions: word ? ['pdf', 'docx', 'doc'] : ['pdf'] }));
  }

  // ── import ──

  async importFile(
    auth: AuthContextType,
    envelope_id: string,
    body: { provider?: unknown; file_id?: unknown } | undefined,
    requestId: string,
    opts: { ifMatch?: string; idempotencyKey?: string } = {},
  ) {
    const provider = this.provider(body?.provider, requestId);
    const file_id = body?.file_id;
    if (typeof file_id !== 'string' || file_id.length === 0 || file_id.length > MAX_ID) throw refusal('VALIDATION_ERROR', 400, 'file_id is required', 'invalid_file_id', requestId, { field: 'file_id' });
    // The same author check the upload makes, before anything is fetched from the provider.
    await this.context.assertCanAuthor(auth, requestId);
    const file = await this.withClient(auth, provider, requestId, async (c) => {
      const meta = await c.metadata(file_id);
      if (meta.kind !== 'file') throw refusal('VALIDATION_ERROR', 400, 'Choose a file, not a folder', 'cloud_not_a_file', requestId);
      const ext = extensionOf(meta.name);
      const word = ext === 'docx' || ext === 'doc';
      const limit = word ? MAX_WORD_BYTES : MAX_PDF_BYTES;
      if (meta.size !== null && meta.size > limit) throw new CloudProviderError('too_large', null, 'declared size over the limit');
      return { name: meta.name, bytes: await c.download(file_id, limit) };
    });
    // The upload decides everything else, exactly as for a file from the device.
    return this.envelopes.upload(
      auth,
      envelope_id,
      { filename: file.name, title: titleFromFilename(file.name), content_base64: Buffer.from(file.bytes).toString('base64') },
      requestId,
      opts,
    );
  }

  // ── export ──

  async exportExecuted(
    auth: AuthContextType,
    envelope_id: string,
    body: { provider?: unknown; folder_id?: unknown; include_certificate?: unknown } | undefined,
    requestId: string,
  ): Promise<{ provider: CloudProviderId; folder: { id: string; name: string }; saved: Array<{ name: string; web_url: string | null }> }> {
    const provider = this.provider(body?.provider, requestId);
    const folder_id = body?.folder_id;
    if (folder_id !== undefined && folder_id !== null && (typeof folder_id !== 'string' || folder_id.length === 0 || folder_id.length > MAX_ID)) {
      throw refusal('VALIDATION_ERROR', 400, 'folder_id is invalid', 'invalid_folder_id', requestId, { field: 'folder_id' });
    }
    if (typeof folder_id === 'string' && !OAUTH_SPECS[provider].export_folder_choice) {
      throw refusal('INVALID_REQUEST', 409, 'This provider saves to the Aramo Sign folder', 'cloud_folder_not_writable', requestId);
    }
    // The same source and rule as GET envelopes/:id/executed (a COMPLETED, unpurged envelope).
    const bundle = await this.envelopes.executed(auth, envelope_id, requestId);
    const files = bundle.documents.map((d) => ({ name: signedCopyName(d.title), bytes: new Uint8Array(Buffer.from(d.executed_base64, 'base64')) }));
    if (body?.include_certificate === true && bundle.certificate !== null && bundle.certificate !== undefined) {
      const cert = bundle.certificate as { certificate_base64?: unknown };
      if (typeof cert.certificate_base64 === 'string') files.push({ name: `${bundle.documents[0]?.title ?? 'Envelope'} (certificate).pdf`, bytes: new Uint8Array(Buffer.from(cert.certificate_base64, 'base64')) });
    }
    return this.withClient(auth, provider, requestId, async (c) => {
      const folder = typeof folder_id === 'string' ? await c.folder(folder_id) : await c.ensureFolder(CLOUD_EXPORT_FOLDER);
      const saved: Array<{ name: string; web_url: string | null }> = [];
      for (const f of files) {
        const s = await c.upload(folder, f.name, f.bytes, 'application/pdf');
        saved.push({ name: s.name, web_url: s.web_url });
      }
      return { provider, folder, saved };
    });
  }
}
