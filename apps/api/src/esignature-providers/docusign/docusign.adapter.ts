import { PDFDocument } from 'pdf-lib';
import type {
  CreateEnvelopeRequest,
  EnvelopeSummary,
  EvidenceSummary,
} from '@aramo/documents-contracts';

import {
  providerFailure,
  type ExternalSignatureAdapter,
  type ProviderCompletion,
  type ProviderConnectionState,
} from '../external-signature-adapter.js';
import { codeChallenge } from '../pkce.js';
import type { ProviderCredentialStore, ProviderTokens } from '../provider-credential-store.js';

import { DOCUSIGN_EVIDENCE_KIND } from './docusign-connect.js';
import type { DocuSignConfig } from './docusign.config.js';

// Multi-Provider directive §G — DocuSign eSignature REST v2.1 behind the provider-
// neutral SignatureProviderPort. Authorization Code Grant with PKCE (confidential
// client), tokens in connector custody with refresh before expiry, account and
// base_uri from /oauth/userinfo. Envelopes are created as drafts ("created") and
// sent explicitly, mirroring the native create → send seam the allowance and
// routing rely on. Status vocabulary is normalized to the native one.
//
// Documented behaviour this follows (verify in the sandbox — pending credentials):
//   POST {oauth}/oauth/token (authorization_code | refresh_token), GET {oauth}/oauth/userinfo
//   POST /restapi/v2.1/accounts/{id}/envelopes            create (status "created")
//   PUT  /envelopes/{envelopeId}                           { status: "sent" } | { status: "voided", voidedReason }
//   PUT  /envelopes/{envelopeId}/recipients?resend_envelope=true   reminder
//   GET  /envelopes/{envelopeId}/documents/combined | /documents/certificate

const STATUS: Record<string, string> = {
  created: 'DRAFT',
  sent: 'SENT',
  delivered: 'IN_PROGRESS',
  completed: 'COMPLETED',
  declined: 'DECLINED',
  voided: 'VOIDED',
};
const TERMINAL = new Set(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']);
const REFRESH_MARGIN_MS = 60_000;

interface RouteReader {
  findRoute(tenant_id: string, document_id: string, document_revision_id: string): Promise<{ provider: string; provider_envelope_ref: string } | null>;
}
interface SourceReader {
  getSourceBase64(tenant_id: string, revision_id: string, requestId: string): Promise<string | null>;
}

export class DocuSignAdapter implements ExternalSignatureAdapter {
  readonly provider = 'docusign' as const;

  constructor(
    private readonly config: DocuSignConfig,
    private readonly store: ProviderCredentialStore,
    private readonly routes: RouteReader,
    private readonly source: SourceReader,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  // ── connection ───────────────────────────────────────────────────────────────
  connectionState(tenant_id: string): Promise<ProviderConnectionState> {
    return this.store.state(tenant_id, 'docusign');
  }

  authorizeUrl(input: { state: string; code_verifier: string }): string {
    const u = new URL(`${this.config.oauthBaseUrl}/oauth/auth`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'signature extended');
    u.searchParams.set('client_id', this.config.integrationKey);
    u.searchParams.set('redirect_uri', this.config.redirectUri);
    u.searchParams.set('state', input.state);
    u.searchParams.set('code_challenge', codeChallenge(input.code_verifier));
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  private async token(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.oauthBaseUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${this.config.integrationKey}:${this.config.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      throw providerFailure('docusign', 'PROVIDER_UNAVAILABLE');
    }
    if (res.status >= 500) throw providerFailure('docusign', 'PROVIDER_UNAVAILABLE');
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || body.access_token === undefined) {
      throw Object.assign(providerFailure('docusign', 'PROVIDER_DISCONNECTED', { provider_error: body.error ?? `HTTP_${res.status}` }), { oauthRejected: true });
    }
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in ?? 3600 };
  }

  async completeAuthorization(input: { tenant_id: string; code: string; code_verifier: string }): Promise<void> {
    const t = await this.token({ grant_type: 'authorization_code', code: input.code, code_verifier: input.code_verifier, redirect_uri: this.config.redirectUri });
    const res = await this.fetchFn(`${this.config.oauthBaseUrl}/oauth/userinfo`, { headers: { authorization: `Bearer ${t.access_token}` } });
    if (!res.ok) throw providerFailure('docusign', res.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REFUSED', { provider_error: `USERINFO_HTTP_${res.status}` });
    const info = (await res.json()) as { accounts?: { account_id: string; base_uri: string; is_default?: boolean }[] };
    const account = info.accounts?.find((a) => a.is_default) ?? info.accounts?.[0];
    if (account === undefined || t.refresh_token === undefined) throw providerFailure('docusign', 'PROVIDER_REFUSED', { provider_error: 'NO_ACCOUNT' });
    const tokens: ProviderTokens = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + t.expires_in * 1000,
      account_id: account.account_id,
      base_uri: account.base_uri.replace(/\/+$/, ''),
    };
    await this.store.save(input.tenant_id, 'docusign', tokens, account.account_id);
  }

  async disconnect(tenant_id: string): Promise<void> {
    // DocuSign has no token revocation endpoint for this grant: the tokens are
    // tombstoned in custody and the connection is disabled.
    await this.store.disconnect(tenant_id, 'docusign');
  }

  private async fresh(tenant_id: string): Promise<ProviderTokens> {
    const tokens = await this.store.load(tenant_id, 'docusign');
    if (tokens === null) throw providerFailure('docusign', 'PROVIDER_DISCONNECTED');
    if (tokens.expires_at - REFRESH_MARGIN_MS > Date.now()) return tokens;
    try {
      const t = await this.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      const next: ProviderTokens = { ...tokens, access_token: t.access_token, refresh_token: t.refresh_token ?? tokens.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
      await this.store.save(tenant_id, 'docusign', next, tokens.account_id);
      return next;
    } catch (e) {
      if ((e as { oauthRejected?: boolean }).oauthRejected) {
        await this.store.markDegraded(tenant_id, 'docusign', 'OAUTH_REFRESH_REJECTED', 'DocuSign refused the refresh token; reconnect required');
      }
      throw e;
    }
  }

  // ── API ──────────────────────────────────────────────────────────────────────
  private async api(tenant_id: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<Response> {
    const t = await this.fresh(tenant_id);
    let res: Response;
    try {
      res = await this.fetchFn(`${t.base_uri}/restapi/v2.1/accounts/${t.account_id}${path}`, {
        method,
        headers: { authorization: `Bearer ${t.access_token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw providerFailure('docusign', 'PROVIDER_UNAVAILABLE');
    }
    if (res.ok) return res;
    if (res.status === 401) {
      await this.store.markDegraded(tenant_id, 'docusign', 'UNAUTHORIZED', 'DocuSign rejected the access token');
      throw providerFailure('docusign', 'PROVIDER_DISCONNECTED');
    }
    if (res.status >= 500 || res.status === 429) throw providerFailure('docusign', 'PROVIDER_UNAVAILABLE');
    const err = (await res.json().catch(() => ({}))) as { errorCode?: string };
    throw providerFailure('docusign', 'PROVIDER_REFUSED', { provider_error: err.errorCode ?? `HTTP_${res.status}` });
  }

  private summarize(env: { envelopeId: string; status: string; recipients?: { signers?: { recipientId: string; email: string; status: string }[] } }): EnvelopeSummary {
    return {
      envelope_id: env.envelopeId,
      status: STATUS[env.status] ?? 'SENT',
      signers: (env.recipients?.signers ?? []).map((s) => ({ signer_id: s.recipientId, email: s.email, status: s.status.toUpperCase() })),
    };
  }

  private async read(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    const res = await this.api(tenant_id, 'GET', `/envelopes/${encodeURIComponent(envelope_id)}?include=recipients`);
    return this.summarize((await res.json()) as never);
  }

  async createEnvelope(req: CreateEnvelopeRequest): Promise<EnvelopeSummary> {
    const documents = [];
    let lastPage = 1;
    let pageHeight = 792;
    for (const [i, d] of req.documents.entries()) {
      const b64 = await this.source.getSourceBase64(req.tenant_id, d.document_revision_ref, '');
      if (b64 === null) throw providerFailure('docusign', 'PROVIDER_REFUSED', { provider_error: 'SOURCE_UNAVAILABLE' });
      if (i === 0) {
        const pdf = await PDFDocument.load(Buffer.from(b64, 'base64'));
        lastPage = pdf.getPageCount();
        pageHeight = pdf.getPage(lastPage - 1).getHeight();
      }
      documents.push({ documentBase64: b64, name: d.title, fileExtension: 'pdf', documentId: String(i + 1) });
    }
    // One signature (with its date) on the last page of the first document.
    const y = Math.max(40, Math.round(pageHeight - 160));
    const signers = req.signers.map((s, i) => ({
      email: s.email,
      name: s.name,
      recipientId: String(i + 1),
      routingOrder: String(s.signing_order),
      tabs: {
        signHereTabs: [{ documentId: '1', pageNumber: String(lastPage), xPosition: '72', yPosition: String(y) }],
        dateSignedTabs: [{ documentId: '1', pageNumber: String(lastPage), xPosition: '360', yPosition: String(y + 20) }],
      },
    }));
    const res = await this.api(req.tenant_id, 'POST', '/envelopes', {
      emailSubject: req.subject.slice(0, 100),
      status: 'created',
      documents,
      recipients: { signers },
    });
    const created = (await res.json()) as { envelopeId: string; status: string };
    return { envelope_id: created.envelopeId, status: STATUS[created.status] ?? 'DRAFT', signers: signers.map((s) => ({ signer_id: s.recipientId, email: s.email, status: 'CREATED' })) };
  }

  async sendEnvelope(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    await this.api(tenant_id, 'PUT', `/envelopes/${encodeURIComponent(envelope_id)}`, { status: 'sent' });
    return this.read(tenant_id, envelope_id);
  }

  getEnvelope(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    return this.read(tenant_id, envelope_id);
  }

  async voidEnvelope(tenant_id: string, envelope_id: string, reason: string): Promise<EnvelopeSummary> {
    await this.api(tenant_id, 'PUT', `/envelopes/${encodeURIComponent(envelope_id)}`, { status: 'voided', voidedReason: reason.slice(0, 200) });
    return this.read(tenant_id, envelope_id);
  }

  getEvidence(): Promise<EvidenceSummary> {
    // DocuSign's evidence is its Certificate of Completion (fetchCompletion), stored
    // under its own role; it is never presented as the Aramo evidence manifest.
    return Promise.reject(providerFailure('docusign', 'PROVIDER_REFUSED', { provider_error: 'EVIDENCE_IS_PROVIDER_ARTIFACT' }));
  }

  async findEnvelopeForDocument(tenant_id: string, document_ref: string, document_revision_ref: string): Promise<EnvelopeSummary | null> {
    const route = await this.routes.findRoute(tenant_id, document_ref, document_revision_ref);
    if (route === null || route.provider !== 'docusign') return null;
    const env = await this.read(tenant_id, route.provider_envelope_ref);
    return TERMINAL.has(env.status) ? null : env;
  }

  async remindEnvelopeSigner(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary> {
    const res = await this.api(tenant_id, 'GET', `/envelopes/${encodeURIComponent(envelope_id)}/recipients`);
    const { signers = [] } = (await res.json()) as { signers?: { recipientId: string; email: string; name: string; status: string }[] };
    const pending = signers.filter((s) => s.status !== 'completed').map((s) => ({ recipientId: s.recipientId, email: s.email, name: s.name }));
    await this.api(tenant_id, 'PUT', `/envelopes/${encodeURIComponent(envelope_id)}/recipients?resend_envelope=true`, { signers: pending });
    return this.read(tenant_id, envelope_id);
  }

  async fetchCompletion(tenant_id: string, envelope_ref: string): Promise<ProviderCompletion | null> {
    const res = await this.api(tenant_id, 'GET', `/envelopes/${encodeURIComponent(envelope_ref)}`);
    const env = (await res.json()) as { status?: string };
    if (env.status !== 'completed') return null;
    const combined = await this.api(tenant_id, 'GET', `/envelopes/${encodeURIComponent(envelope_ref)}/documents/combined`);
    const certificate = await this.api(tenant_id, 'GET', `/envelopes/${encodeURIComponent(envelope_ref)}/documents/certificate`);
    return {
      executed_pdf: Buffer.from(await combined.arrayBuffer()),
      evidence_pdf: Buffer.from(await certificate.arrayBuffer()),
      evidence_kind: DOCUSIGN_EVIDENCE_KIND,
    };
  }
}
