import type { CreateEnvelopeRequest, EnvelopeSummary, EvidenceSummary } from '@aramo/documents-contracts';

import {
  providerFailure,
  type ExternalSignatureAdapter,
  type ProviderCompletion,
  type ProviderConnectionState,
} from '../external-signature-adapter.js';
import type { ProviderCredentialStore, ProviderTokens } from '../provider-credential-store.js';

import { ADOBE_SIGN_EVIDENCE_KIND, isAdobeSignHost } from './adobe-sign-webhook.js';
import type { AdobeSignConfig } from './adobe-sign.config.js';

// Multi-Provider directive §G — Adobe Acrobat Sign REST v6 behind the provider-
// neutral SignatureProviderPort. OAuth v2 authorization code (confidential client):
// tokens are exchanged and refreshed at the account's api_access_point (trusted only
// when it is an Adobe Sign host), and revoked at disconnect. Agreements are created
// as DRAFT and moved IN_PROCESS on send, mirroring the native create → send seam.
// With no form fields Adobe appends its own signature block.
//
// Documented behaviour this follows (verify in the sandbox — pending credentials):
//   {oauth}/public/oauth/v2 (authorize) · {api}oauth/v2/token|refresh|revoke
//   POST api/rest/v6/transientDocuments (multipart "File") · POST api/rest/v6/agreements
//   PUT  agreements/{id}/state { IN_PROCESS | CANCELLED + agreementCancellationInfo }
//   GET  agreements/{id}/members · POST agreements/{id}/reminders
//   GET  agreements/{id}/combinedDocument · agreements/{id}/auditTrail
//   POST api/rest/v6/webhooks (AGREEMENT_WORKFLOW_COMPLETED)

const STATUS: Record<string, string> = {
  DRAFT: 'DRAFT',
  AUTHORING: 'DRAFT',
  OUT_FOR_SIGNATURE: 'SENT',
  OUT_FOR_APPROVAL: 'SENT',
  OUT_FOR_DELIVERY: 'SENT',
  OUT_FOR_ACCEPTANCE: 'SENT',
  OUT_FOR_FORM_FILLING: 'SENT',
  WAITING_FOR_MY_SIGNATURE: 'IN_PROGRESS',
  SIGNED: 'COMPLETED',
  APPROVED: 'COMPLETED',
  ACCEPTED: 'COMPLETED',
  DELIVERED: 'COMPLETED',
  FORM_FILLED: 'COMPLETED',
  CANCELLED: 'VOIDED',
  EXPIRED: 'EXPIRED',
};
const COMPLETED = new Set(['SIGNED', 'APPROVED', 'ACCEPTED', 'DELIVERED', 'FORM_FILLED']);
const TERMINAL = new Set(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']);
const REFRESH_MARGIN_MS = 60_000;
const SCOPES = 'user_read:account agreement_read:account agreement_write:account agreement_send:account webhook_read:account webhook_write:account';

interface RouteReader {
  findRoute(tenant_id: string, document_id: string, document_revision_id: string): Promise<{ provider: string; provider_envelope_ref: string } | null>;
}
interface SourceReader {
  getSourceBase64(tenant_id: string, revision_id: string, requestId: string): Promise<string | null>;
}

export class AdobeSignAdapter implements ExternalSignatureAdapter {
  readonly provider = 'adobe_sign' as const;

  constructor(
    private readonly config: AdobeSignConfig,
    private readonly store: ProviderCredentialStore,
    private readonly routes: RouteReader,
    private readonly source: SourceReader,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  connectionState(tenant_id: string): Promise<ProviderConnectionState> {
    return this.store.state(tenant_id, 'adobe_sign');
  }

  authorizeUrl(input: { state: string }): string {
    const u = new URL(`${this.config.oauthBaseUrl}/public/oauth/v2`);
    u.searchParams.set('redirect_uri', this.config.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.config.clientId);
    u.searchParams.set('state', input.state);
    u.searchParams.set('scope', SCOPES);
    return u.toString();
  }

  private async oauth(api: string, path: 'token' | 'refresh', form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${api}oauth/v2/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...form, client_id: this.config.clientId, client_secret: this.config.clientSecret }).toString(),
      });
    } catch {
      throw providerFailure('adobe_sign', 'PROVIDER_UNAVAILABLE');
    }
    if (res.status >= 500) throw providerFailure('adobe_sign', 'PROVIDER_UNAVAILABLE');
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || body.access_token === undefined) {
      throw Object.assign(providerFailure('adobe_sign', 'PROVIDER_DISCONNECTED', { provider_error: body.error ?? `HTTP_${res.status}` }), { oauthRejected: true });
    }
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in ?? 3600 };
  }

  async completeAuthorization(input: { tenant_id: string; code: string; callback_params?: Record<string, string> }): Promise<void> {
    const raw = input.callback_params?.['api_access_point'] ?? '';
    if (!isAdobeSignHost(raw)) throw providerFailure('adobe_sign', 'PROVIDER_REFUSED', { provider_error: 'UNTRUSTED_API_ACCESS_POINT' });
    const api = raw.endsWith('/') ? raw : `${raw}/`;
    const t = await this.oauth(api, 'token', { grant_type: 'authorization_code', code: input.code, redirect_uri: this.config.redirectUri });
    if (t.refresh_token === undefined) throw providerFailure('adobe_sign', 'PROVIDER_REFUSED', { provider_error: 'NO_REFRESH_TOKEN' });
    const me = await this.call(api, t.access_token, 'GET', 'api/rest/v6/users/me');
    const { accountId } = (await me.json()) as { accountId?: string };
    if (accountId === undefined) throw providerFailure('adobe_sign', 'PROVIDER_REFUSED', { provider_error: 'NO_ACCOUNT' });
    // Completion notifications for this user's agreements (best-effort duplicates are harmless).
    await this.call(api, t.access_token, 'POST', 'api/rest/v6/webhooks', {
      name: 'Aramo — agreement completed',
      scope: 'USER',
      state: 'ACTIVE',
      webhookSubscriptionEvents: ['AGREEMENT_WORKFLOW_COMPLETED'],
      webhookUrlInfo: { url: this.config.webhookUrl },
    });
    const tokens: ProviderTokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000, account_id: accountId, base_uri: api };
    await this.store.save(input.tenant_id, 'adobe_sign', tokens, accountId);
  }

  async disconnect(tenant_id: string): Promise<void> {
    const tokens = await this.store.load(tenant_id, 'adobe_sign');
    if (tokens !== null && isAdobeSignHost(tokens.base_uri)) {
      // Revoking the refresh token also revokes the access tokens issued from it.
      await this.fetchFn(`${tokens.base_uri}oauth/v2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refresh_token }).toString(),
      }).catch(() => undefined);
    }
    await this.store.disconnect(tenant_id, 'adobe_sign');
  }

  private async fresh(tenant_id: string): Promise<ProviderTokens> {
    const tokens = await this.store.load(tenant_id, 'adobe_sign');
    if (tokens === null || !isAdobeSignHost(tokens.base_uri)) throw providerFailure('adobe_sign', 'PROVIDER_DISCONNECTED');
    if (tokens.expires_at - REFRESH_MARGIN_MS > Date.now()) return tokens;
    try {
      const t = await this.oauth(tokens.base_uri, 'refresh', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      const next: ProviderTokens = { ...tokens, access_token: t.access_token, refresh_token: t.refresh_token ?? tokens.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
      await this.store.save(tenant_id, 'adobe_sign', next, tokens.account_id);
      return next;
    } catch (e) {
      if ((e as { oauthRejected?: boolean }).oauthRejected) {
        await this.store.markDegraded(tenant_id, 'adobe_sign', 'OAUTH_REFRESH_REJECTED', 'Adobe Acrobat Sign refused the refresh token; reconnect required');
      }
      throw e;
    }
  }

  private async call(api: string, accessToken: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown | FormData, tenant_id?: string): Promise<Response> {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    let res: Response;
    try {
      res = await this.fetchFn(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: isForm ? (body as FormData) : JSON.stringify(body) } : {}),
      });
    } catch {
      throw providerFailure('adobe_sign', 'PROVIDER_UNAVAILABLE');
    }
    if (res.ok) return res;
    if (res.status === 401 && tenant_id !== undefined) {
      await this.store.markDegraded(tenant_id, 'adobe_sign', 'UNAUTHORIZED', 'Adobe Acrobat Sign rejected the access token');
      throw providerFailure('adobe_sign', 'PROVIDER_DISCONNECTED');
    }
    if (res.status >= 500 || res.status === 429) throw providerFailure('adobe_sign', 'PROVIDER_UNAVAILABLE');
    const err = (await res.json().catch(() => ({}))) as { code?: string };
    throw providerFailure('adobe_sign', 'PROVIDER_REFUSED', { provider_error: err.code ?? `HTTP_${res.status}` });
  }

  private async api(tenant_id: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<Response> {
    const t = await this.fresh(tenant_id);
    return this.call(t.base_uri, t.access_token, method, `api/rest/v6/${path}`, body, tenant_id);
  }

  private async read(tenant_id: string, id: string): Promise<EnvelopeSummary> {
    const res = await this.api(tenant_id, 'GET', `agreements/${encodeURIComponent(id)}`);
    const a = (await res.json()) as { id: string; status: string };
    return { envelope_id: a.id, status: STATUS[a.status] ?? 'SENT', signers: [] };
  }

  async createEnvelope(req: CreateEnvelopeRequest): Promise<EnvelopeSummary> {
    const fileInfos = [];
    for (const d of req.documents) {
      const b64 = await this.source.getSourceBase64(req.tenant_id, d.document_revision_ref, '');
      if (b64 === null) throw providerFailure('adobe_sign', 'PROVIDER_REFUSED', { provider_error: 'SOURCE_UNAVAILABLE' });
      const form = new FormData();
      form.append('File-Name', `${d.title}.pdf`);
      form.append('File', new Blob([Buffer.from(b64, 'base64')], { type: 'application/pdf' }), `${d.title}.pdf`);
      const up = await this.api(req.tenant_id, 'POST', 'transientDocuments', form);
      fileInfos.push({ transientDocumentId: ((await up.json()) as { transientDocumentId: string }).transientDocumentId });
    }
    const res = await this.api(req.tenant_id, 'POST', 'agreements', {
      fileInfos,
      name: req.subject.slice(0, 255),
      participantSetsInfo: req.signers.map((s) => ({ memberInfos: [{ email: s.email }], order: s.signing_order, role: 'SIGNER' })),
      signatureType: 'ESIGN',
      state: 'DRAFT',
    });
    const { id } = (await res.json()) as { id: string };
    return { envelope_id: id, status: 'DRAFT', signers: req.signers.map((s, i) => ({ signer_id: String(i + 1), email: s.email, status: 'CREATED' })) };
  }

  async sendEnvelope(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    await this.api(tenant_id, 'PUT', `agreements/${encodeURIComponent(envelope_id)}/state`, { state: 'IN_PROCESS' });
    return this.read(tenant_id, envelope_id);
  }

  getEnvelope(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    return this.read(tenant_id, envelope_id);
  }

  async voidEnvelope(tenant_id: string, envelope_id: string, reason: string): Promise<EnvelopeSummary> {
    await this.api(tenant_id, 'PUT', `agreements/${encodeURIComponent(envelope_id)}/state`, {
      state: 'CANCELLED',
      agreementCancellationInfo: { comment: reason.slice(0, 255), notifyOthers: true },
    });
    return this.read(tenant_id, envelope_id);
  }

  getEvidence(): Promise<EvidenceSummary> {
    // Adobe's evidence is its audit report (fetchCompletion), stored under its own role.
    return Promise.reject(providerFailure('adobe_sign', 'PROVIDER_REFUSED', { provider_error: 'EVIDENCE_IS_PROVIDER_ARTIFACT' }));
  }

  async findEnvelopeForDocument(tenant_id: string, document_ref: string, document_revision_ref: string): Promise<EnvelopeSummary | null> {
    const route = await this.routes.findRoute(tenant_id, document_ref, document_revision_ref);
    if (route === null || route.provider !== 'adobe_sign') return null;
    const env = await this.read(tenant_id, route.provider_envelope_ref);
    return TERMINAL.has(env.status) ? null : env;
  }

  async remindEnvelopeSigner(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    const res = await this.api(tenant_id, 'GET', `agreements/${encodeURIComponent(envelope_id)}/members`);
    const { nextParticipantSets = [] } = (await res.json()) as { nextParticipantSets?: { memberInfos?: { id: string }[] }[] };
    const ids = nextParticipantSets.flatMap((s) => (s.memberInfos ?? []).map((m) => m.id));
    await this.api(tenant_id, 'POST', `agreements/${encodeURIComponent(envelope_id)}/reminders`, { recipientParticipantIds: ids, status: 'ACTIVE' });
    return this.read(tenant_id, envelope_id);
  }

  async fetchCompletion(tenant_id: string, envelope_ref: string): Promise<ProviderCompletion | null> {
    const res = await this.api(tenant_id, 'GET', `agreements/${encodeURIComponent(envelope_ref)}`);
    const a = (await res.json()) as { status?: string };
    if (a.status === undefined || !COMPLETED.has(a.status)) return null;
    const combined = await this.api(tenant_id, 'GET', `agreements/${encodeURIComponent(envelope_ref)}/combinedDocument`);
    const audit = await this.api(tenant_id, 'GET', `agreements/${encodeURIComponent(envelope_ref)}/auditTrail`);
    return {
      executed_pdf: Buffer.from(await combined.arrayBuffer()),
      evidence_pdf: Buffer.from(await audit.arrayBuffer()),
      evidence_kind: ADOBE_SIGN_EVIDENCE_KIND,
    };
  }
}
