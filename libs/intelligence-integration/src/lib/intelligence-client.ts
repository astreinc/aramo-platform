import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  SOURCE_SYSTEM_ARAMO_ATS,
  formatReferenceParam,
  type ContradictionResolution,
  type ContradictionResolutionResponse,
  type DisputeActionResponse,
  type PortalDisputeListResponse,
  type PortalDisputeView,
  type PortalVerificationsResponse,
  type ProposalAction,
  type ProposalKind,
  type ProposalListResponse,
  type ProposalStatus,
  type ProposalView,
  type ReferenceVerificationsResponse,
  type TalentReferenceTuple,
  type TenantDisputeListResponse,
  type TenantDisputeView,
  type ConfirmVerificationResponse,
  type CreateVerificationRequest,
  type CreateVerificationResponse,
  type EntitlementSyncRequest,
  type EntitlementSyncResponse,
  type IntelligenceEvidenceReadResponse,
  type IntelligenceProfileReadResponse,
  type ServiceTokenResponse,
  type TalentErasedRequest,
  type TalentErasedResponse,
  type TalentIngestRequest,
  type TalentIngestResponse,
} from '@aramo/intelligence-contracts';

import { INTELLIGENCE_INTEGRATION_CONFIG, type IntelligenceIntegrationConfig } from './intelligence-config.js';

// ATI-SEP-1 T8 (ADR-0036 §3 "Service auth (E-2)") — the ATS's ONLY channel to
// Talent Intelligence: HTTP + @aramo/intelligence-contracts DTOs (the A7 wall —
// no scope:intelligence import). A client_credentials token from
// POST /v1/oauth/token is cached until shortly before it expires; a 401 from a
// TI route drops it and retries the call once with a fresh token.
//
// Every call has a hard timeout (INTELLIGENCE_HTTP_TIMEOUT_MS, default 5 s) and
// fails with a TYPED error:
//   IntelligenceNotConfiguredError — URL / credentials unset (callers no-op);
//   IntelligenceUnavailableError   — network, timeout, 5xx, 429 (retryable);
//   IntelligenceRejectedError      — any other 4xx (status + TI error code).
// This client is NEVER called from an ATS create / update request path: the
// publisher runs in the worker's outbox drain, the inbound sync in the worker's
// inbox drain; the inline callers are the opt-in portal verification route and
// the T10 recruiter trust surfaces (dossier, proposals, disputes, email
// verification), which are enrichment only and fail soft.

export class IntelligenceNotConfiguredError extends Error {
  constructor() {
    super('Talent Intelligence is not configured (INTELLIGENCE_SERVICE_URL / INTELLIGENCE_ATS_CLIENT_ID / INTELLIGENCE_ATS_CLIENT_SECRET)');
    this.name = 'IntelligenceNotConfiguredError';
  }
}

export class IntelligenceUnavailableError extends Error {
  readonly retryable = true;
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'IntelligenceUnavailableError';
  }
}

export class IntelligenceRejectedError extends Error {
  readonly retryable = false;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'IntelligenceRejectedError';
  }
}

export type IntelligenceFetch = (input: string, init: RequestInit) => Promise<Response>;
/** DI token — overridable fetch (tests). Defaults to globalThis.fetch. */
export const INTELLIGENCE_FETCH = 'INTELLIGENCE_FETCH';

/** An ATS talent record as TI knows it: the reference (ARAMO_ATS, tenant, talent). */
export interface AtsTalentRef {
  tenant_id: string;
  talent_id: string;
}

/** A tenant-side dispute / proposal action: the acting tenant + the ATS user (opaque id). */
export interface AtsTenantActor {
  tenant_id: string;
  actor: string;
}

export interface WorklistPage {
  cursor?: string;
  limit?: number;
}

const atsTuple = (r: AtsTalentRef): TalentReferenceTuple => ({
  source_system_id: SOURCE_SYSTEM_ARAMO_ATS,
  source_tenant_id: r.tenant_id,
  external_talent_id: r.talent_id,
});

const referencePath = (r: AtsTalentRef): string =>
  `/v1/references/${encodeURIComponent(SOURCE_SYSTEM_ARAMO_ATS)}/${encodeURIComponent(r.tenant_id)}/${encodeURIComponent(r.talent_id)}`;

/** `?k=v&…` from defined values; arrays repeat the key. Empty → ''. */
function query(params: Record<string, string | number | undefined | string[]>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [String(v)]) q.append(k, one);
  }
  const s = q.toString();
  return s.length > 0 ? `?${s}` : '';
}

const references = (refs: AtsTalentRef[]): string[] => refs.map((r) => formatReferenceParam(atsTuple(r)));

/** Refresh the token this many seconds before it expires. */
const TOKEN_REFRESH_MARGIN_SEC = 60;

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

@Injectable()
export class IntelligenceClient {
  private token: CachedToken | null = null;
  private tokenInFlight: Promise<string> | null = null;
  private readonly fetchImpl: IntelligenceFetch;

  constructor(
    @Inject(INTELLIGENCE_INTEGRATION_CONFIG) private readonly config: IntelligenceIntegrationConfig,
    @Optional() @Inject(INTELLIGENCE_FETCH) fetchImpl?: IntelligenceFetch,
    @Optional() @Inject('INTELLIGENCE_CLOCK') private readonly now: () => number = Date.now,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  get configured(): boolean {
    return this.config.configured;
  }

  // ── API surface ────────────────────────────────────────────────────────────

  ingestTalent(body: TalentIngestRequest): Promise<TalentIngestResponse> {
    return this.call<TalentIngestResponse>('POST', '/v1/ingest/talent', body);
  }

  ingestErased(body: TalentErasedRequest): Promise<TalentErasedResponse> {
    return this.call<TalentErasedResponse>('POST', '/v1/ingest/talent/erased', body);
  }

  syncEntitlements(body: EntitlementSyncRequest): Promise<EntitlementSyncResponse> {
    return this.call<EntitlementSyncResponse>('POST', '/v1/entitlements/sync', body);
  }

  readProfile(args: { tenant_id: string; talent_id: string }): Promise<IntelligenceProfileReadResponse> {
    return this.call<IntelligenceProfileReadResponse>('GET', `${referencePath(args)}/profile`);
  }

  /** The tenant-view evidence (assertions + their history) behind the profile (scope intelligence:read). */
  readEvidence(args: AtsTalentRef): Promise<IntelligenceEvidenceReadResponse> {
    return this.call<IntelligenceEvidenceReadResponse>('GET', `${referencePath(args)}/evidence`);
  }

  requestVerification(body: CreateVerificationRequest): Promise<CreateVerificationResponse> {
    return this.call<CreateVerificationResponse>('POST', '/v1/verifications', body);
  }

  confirmVerification(verificationId: string, code: string): Promise<ConfirmVerificationResponse> {
    return this.call<ConfirmVerificationResponse>('POST', `/v1/verifications/${encodeURIComponent(verificationId)}/confirm`, { code });
  }

  // ── T10 evidence lifecycle (Addendum A3 T10-2 / T10-3) ────────────────────
  // Enrichment only: a failure here never blocks an ATS decision.

  /** M-1 — verification status of one ATS talent record's contacts (scope intelligence:verify). */
  listReferenceVerifications(ref: AtsTalentRef): Promise<ReferenceVerificationsResponse> {
    return this.call<ReferenceVerificationsResponse>('GET', `${referencePath(ref)}/verifications`);
  }

  /** M-6 — the portal aggregate over the records the talent holds (scope intelligence:verify). */
  aggregateVerifications(refs: AtsTalentRef[]): Promise<PortalVerificationsResponse> {
    return this.call<PortalVerificationsResponse>('GET', `/v1/verifications${query({ reference: references(refs) })}`);
  }

  /** M-4 portal — the talent disputes one assertion through a record they hold (scope intelligence:disputes). */
  openDispute(args: AtsTalentRef & { assertion_id: string; statement: string }): Promise<PortalDisputeView> {
    return this.call<PortalDisputeView>('POST', '/v1/disputes', { portal_context: atsTuple(args), assertion_id: args.assertion_id, statement: args.statement });
  }

  listPortalDisputes(refs: AtsTalentRef[], opts: { status?: string } = {}): Promise<PortalDisputeListResponse> {
    return this.call<PortalDisputeListResponse>('GET', `/v1/disputes${query({ reference: references(refs), status: opts.status })}`);
  }

  getPortalDispute(disputeId: string, refs: AtsTalentRef[]): Promise<PortalDisputeView> {
    return this.call<PortalDisputeView>('GET', `/v1/disputes/${encodeURIComponent(disputeId)}${query({ reference: references(refs) })}`);
  }

  respondToDispute(disputeId: string, args: AtsTalentRef & { statement: string }): Promise<PortalDisputeView> {
    return this.call<PortalDisputeView>('POST', `/v1/disputes/${encodeURIComponent(disputeId)}/respond`, { portal_context: atsTuple(args), statement: args.statement });
  }

  withdrawDispute(disputeId: string, args: AtsTalentRef & { actor?: string }): Promise<PortalDisputeView> {
    return this.call<PortalDisputeView>('POST', `/v1/disputes/${encodeURIComponent(disputeId)}/withdraw`, {
      portal_context: atsTuple(args),
      ...(args.actor !== undefined ? { actor: args.actor } : {}),
    });
  }

  /** M-4 tenant — the dispute worklist (scope intelligence:disputes). status: open (default) | all | a DisputeStatus. */
  listTenantDisputes(tenantId: string, opts: WorklistPage & { status?: string } = {}): Promise<TenantDisputeListResponse> {
    return this.call<TenantDisputeListResponse>(
      'GET',
      `/v1/tenants/${encodeURIComponent(tenantId)}/disputes${query({ status: opts.status, cursor: opts.cursor, limit: opts.limit })}`,
    );
  }

  getTenantDispute(tenantId: string, disputeId: string): Promise<TenantDisputeView> {
    return this.call<TenantDisputeView>('GET', `/v1/tenants/${encodeURIComponent(tenantId)}/disputes/${encodeURIComponent(disputeId)}`);
  }

  triageDispute(disputeId: string, by: AtsTenantActor): Promise<DisputeActionResponse> {
    return this.disputeAction(disputeId, 'triage', by);
  }

  requestDisputeInfo(disputeId: string, by: AtsTenantActor & { note: string }): Promise<DisputeActionResponse> {
    return this.disputeAction(disputeId, 'request-info', by);
  }

  correctDispute(disputeId: string, by: AtsTenantActor & { note: string }): Promise<DisputeActionResponse> {
    return this.disputeAction(disputeId, 'correct', by);
  }

  upholdDispute(disputeId: string, by: AtsTenantActor & { note: string }): Promise<DisputeActionResponse> {
    return this.disputeAction(disputeId, 'uphold', by);
  }

  extendDispute(disputeId: string, by: AtsTenantActor): Promise<DisputeActionResponse> {
    return this.disputeAction(disputeId, 'extend', by);
  }

  /** M-2 — the trust-proposal worklist (scope intelligence:proposals). status defaults to OPEN. */
  listProposals(tenantId: string, opts: WorklistPage & { status?: ProposalStatus; kind?: ProposalKind } = {}): Promise<ProposalListResponse> {
    return this.call<ProposalListResponse>(
      'GET',
      `/v1/tenants/${encodeURIComponent(tenantId)}/proposals${query({ status: opts.status, kind: opts.kind, cursor: opts.cursor, limit: opts.limit })}`,
    );
  }

  dismissProposal(proposalId: string, by: AtsTenantActor & { justification: string }): Promise<ProposalView> {
    return this.call<ProposalView>('POST', `/v1/proposals/${encodeURIComponent(proposalId)}/dismiss`, {
      source_tenant_id: by.tenant_id,
      actor: by.actor,
      justification: by.justification,
    });
  }

  actOnProposal(proposalId: string, by: AtsTenantActor & { action: ProposalAction; note?: string }): Promise<ProposalView> {
    return this.call<ProposalView>('POST', `/v1/proposals/${encodeURIComponent(proposalId)}/act`, {
      source_tenant_id: by.tenant_id,
      actor: by.actor,
      action: by.action,
      ...(by.note !== undefined ? { note: by.note } : {}),
    });
  }

  /** M-3 — resolve a contradiction in the tenant's view, through its own record (scope intelligence:proposals). */
  resolveContradiction(
    ref: AtsTalentRef & { assertion_id: string },
    body: { resolution: ContradictionResolution; reason: string; actor: string },
  ): Promise<ContradictionResolutionResponse> {
    return this.call<ContradictionResolutionResponse>(
      'POST',
      `${referencePath(ref)}/assertions/${encodeURIComponent(ref.assertion_id)}/contradiction-resolution`,
      body,
    );
  }

  private disputeAction(disputeId: string, action: string, by: AtsTenantActor & { note?: string }): Promise<DisputeActionResponse> {
    return this.call<DisputeActionResponse>('POST', `/v1/disputes/${encodeURIComponent(disputeId)}/${action}`, {
      source_tenant_id: by.tenant_id,
      actor: by.actor,
      ...(by.note !== undefined ? { note: by.note } : {}),
    });
  }

  /** Drop the cached token (tests / credential rotation). */
  resetToken(): void {
    this.token = null;
  }

  // ── transport ──────────────────────────────────────────────────────────────

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.config.configured) throw new IntelligenceNotConfiguredError();
    const first = await this.send(method, path, body, await this.accessToken());
    if (first.status !== 401) return this.parse<T>(first);
    // The token was rejected (rotated secret, TI restart with a new signing key):
    // fetch a fresh one and retry exactly once.
    this.token = null;
    return this.parse<T>(await this.send(method, path, body, await this.accessToken()));
  }

  private async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached !== null && cached.expiresAtMs > this.now()) return cached.value;
    if (this.tokenInFlight !== null) return this.tokenInFlight;
    this.tokenInFlight = this.exchange().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async exchange(): Promise<string> {
    const res = await this.send('POST', '/v1/oauth/token', {
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const parsed = await this.parse<ServiceTokenResponse>(res);
    if (typeof parsed?.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new IntelligenceUnavailableError('token exchange returned no access_token', res.status);
    }
    const ttl = Number.isFinite(parsed.expires_in) && parsed.expires_in > 0 ? parsed.expires_in : 300;
    const usable = Math.max(30, ttl - TOKEN_REFRESH_MARGIN_SEC);
    this.token = { value: parsed.access_token, expiresAtMs: this.now() + usable * 1000 };
    return parsed.access_token;
  }

  private async send(method: 'GET' | 'POST', path: string, body: unknown, bearer?: string): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`;
    try {
      return await this.fetchImpl(`${this.config.serviceUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      // Never the URL's query, never a body value — the path + reason only.
      throw new IntelligenceUnavailableError(
        timedOut ? `Talent Intelligence ${method} ${path} timed out after ${this.config.timeoutMs} ms` : `Talent Intelligence ${method} ${path} unreachable`,
      );
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.status >= 200 && res.status < 300) return json as T;
    if (res.status >= 500 || res.status === 429 || res.status === 408) {
      throw new IntelligenceUnavailableError(`Talent Intelligence answered ${res.status}`, res.status);
    }
    const { code, message, details } = errorOf(json);
    throw new IntelligenceRejectedError(res.status, code, message, details);
  }
}

/** TI error bodies: { error: { code, message, ... } } (API) or { error, error_description } (OAuth). */
function errorOf(json: unknown): { code: string; message: string; details: Record<string, unknown> } {
  if (json !== null && typeof json === 'object') {
    const e = (json as Record<string, unknown>)['error'];
    if (e !== null && typeof e === 'object') {
      const { code, message, ...rest } = e as Record<string, unknown>;
      return {
        code: typeof code === 'string' ? code : 'UNKNOWN',
        message: typeof message === 'string' ? message : 'refused',
        details: rest,
      };
    }
    if (typeof e === 'string') {
      const d = (json as Record<string, unknown>)['error_description'];
      return { code: e, message: typeof d === 'string' ? d : e, details: {} };
    }
  }
  return { code: 'UNKNOWN', message: 'refused', details: {} };
}
