import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import {
  RequisitionRepository,
  type PublishableRequisitionRow,
} from '@aramo/requisition';
import {
  buildChannelPostingPayload,
  channelPostingContentHash,
  planPublishableAction,
  shouldExpire,
  INDEED_CHANNEL,
  INDEED_APPLY_WEBHOOK_PATH,
  IndeedJobSyncConnector,
  IndeedTokenService,
  JobDistributionPostingStateRepository,
  type ChannelPostingInput,
  type ChannelPostingStateRow,
  type IndeedApplyConfig,
  type IndeedEmployerId,
  type IndeedJobContext,
} from '@aramo/job-distribution';

import { INDEED_APPLY_WEBHOOK_SECRET_ENV } from '../webhooks/indeed-apply.constants.js';

import { JOB_DISTRIBUTION_PER_TICK_MUTATION_CAP } from './job-distribution-sync.queue.constants.js';

// SRC-2 PR-3 (R4) — the job-distribution freshness-sweep orchestration (apps/api
// composition root, PRIMARY ruling). Injection set is exactly scope-1's:
// RequisitionRepository (the publishable read) + the @aramo/job-distribution
// primitives (posting-state repo, connector, token service). Per-tenant identity
// (company name, source name, apply host) is read from TenantChannelConfig.config
// — a job-distribution primitive, non-secret per R5 — so the sweep needs NO
// @aramo/identity edge.
//
// Per tick, per enabled tenant×'indeed' (TenantChannelConfig.enabled): diff the
// FULL publishable requisition set (status active AND public_listing) against the
// stored ChannelPostingState by content hash, and drive the upsert/expire mutations
// — bounded by a shared per-tick mutation budget (rate-limit respect), serial
// (<= 1/sec), with per-item isolation (one requisition's failure lands ERROR and
// never aborts the tick; the next tick re-plans it).
//
// FAIL-CLOSED: credentials unset → the token service is not configured → the whole
// sweep skips the tick with ONE log line (no token fetch, no crash-loop).

export interface JobDistributionSyncTickResult {
  skipped: boolean;
  reason?: string;
  tenants: number;
  created: number;
  updated: number;
  expired: number;
  errors: number;
  noop: number;
}

interface ParsedIndeedConfig {
  employerIds: IndeedEmployerId[];
  sourceName: string;
  companyName: string;
  country: string;
  applyHost: string | null;
}

@Injectable()
export class JobDistributionSyncService {
  constructor(
    private readonly requisitions: RequisitionRepository,
    private readonly postingStates: JobDistributionPostingStateRepository,
    private readonly connector: IndeedJobSyncConnector,
    private readonly tokens: IndeedTokenService,
    @Inject('JobDistributionSyncServiceLogger')
    private readonly logger: AramoLogger,
  ) {}

  async tick(): Promise<JobDistributionSyncTickResult> {
    const result: JobDistributionSyncTickResult = {
      skipped: false,
      tenants: 0,
      created: 0,
      updated: 0,
      expired: 0,
      errors: 0,
      noop: 0,
    };

    // FAIL-CLOSED — no partner credentials → disabled, skip the whole tick.
    if (!this.tokens.isConfigured) {
      this.logger.warn({
        event: 'job_distribution_sync_skipped',
        reason: 'indeed_credentials_unset',
      });
      return { ...result, skipped: true, reason: 'indeed_credentials_unset' };
    }

    const configs = await this.postingStates.listEnabledConfigs(INDEED_CHANNEL);
    const budget = { remaining: JOB_DISTRIBUTION_PER_TICK_MUTATION_CAP };

    for (const cfg of configs) {
      if (budget.remaining <= 0) break;
      result.tenants += 1;
      try {
        await this.syncTenant(cfg.tenant_id, cfg.config, budget, result);
      } catch (err) {
        // Tenant-level isolation — a config/tenant-load failure never aborts the
        // tick; the next tick re-selects it.
        result.errors += 1;
        this.logger.warn({
          event: 'job_distribution_sync_tenant_failed',
          tenant_id: cfg.tenant_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log({ event: 'job_distribution_sync_tick', ...result });
    return result;
  }

  private async syncTenant(
    tenantId: string,
    rawConfig: unknown,
    budget: { remaining: number },
    result: JobDistributionSyncTickResult,
  ): Promise<void> {
    const parsed = parseIndeedConfig(rawConfig, tenantId);
    if (parsed === null) {
      // Enabled but not fully provisioned (no Indeed employer association yet).
      this.logger.warn({
        event: 'job_distribution_sync_tenant_unconfigured',
        tenant_id: tenantId,
        reason: 'missing_employer_ids',
      });
      return;
    }

    const apply = this.buildApplyConfig(parsed.applyHost);

    const publishable = await this.requisitions.listPublishableForChannelSync({
      tenant_id: tenantId,
    });
    const publishableIds = new Set(publishable.map((r) => r.id));
    const states = await this.postingStates.listStatesForTenantChannel(
      tenantId,
      INDEED_CHANNEL,
    );
    const stateByReq = new Map<string, ChannelPostingStateRow>(
      states.map((s) => [s.requisition_id, s]),
    );

    // Upsert pass — publishable requisitions.
    for (const req of publishable) {
      if (budget.remaining <= 0) return;
      await this.syncPublishable(
        req,
        parsed,
        apply,
        stateByReq.get(req.id) ?? null,
        budget,
        result,
      );
    }

    // Expire pass — states whose requisition left the publishable set.
    for (const state of states) {
      if (budget.remaining <= 0) return;
      if (publishableIds.has(state.requisition_id)) continue;
      if (!shouldExpire(state)) continue;
      await this.expirePosting(tenantId, state, budget, result);
    }
  }

  private async syncPublishable(
    req: PublishableRequisitionRow,
    cfg: ParsedIndeedConfig,
    apply: IndeedApplyConfig | null,
    existing: ChannelPostingStateRow | null,
    budget: { remaining: number },
    result: JobDistributionSyncTickResult,
  ): Promise<void> {
    const input: ChannelPostingInput = {
      requisition_id: req.id,
      tenant_id: req.tenant_id,
      title: req.title,
      description: req.description,
      city: req.city,
      state_code: req.state_code,
      country: cfg.country,
      job_type: req.job_type,
      work_arrangement: req.work_arrangement,
      openings: req.openings,
      advertised_pay_min: req.advertised_pay_min,
      advertised_pay_max: req.advertised_pay_max,
      advertised_pay_period: req.advertised_pay_period,
      advertised_pay_currency: req.advertised_pay_currency,
      public_listing: req.public_listing,
      posted_at: req.updated_at,
      updated_at: req.updated_at,
    };
    const payload = buildChannelPostingPayload(input);
    const contentHash = channelPostingContentHash(payload);
    const action = planPublishableAction({ contentHash, existing });
    if (action === 'NOOP') {
      result.noop += 1;
      return;
    }

    const key = {
      tenant_id: req.tenant_id,
      requisition_id: req.id,
      channel: INDEED_CHANNEL,
    };
    const ctx: IndeedJobContext = {
      jobPostingId: req.id,
      sourceName: cfg.sourceName,
      companyName: cfg.companyName,
      employerIds: cfg.employerIds,
      apply,
    };

    // Phase 1 — stamp intent + target hash BEFORE the connector call (crash-safe).
    await this.postingStates.markPending({
      key,
      sync_status: action === 'CREATE' ? 'PENDING_CREATE' : 'PENDING_UPDATE',
      content_hash: contentHash,
      external_posting_id: existing?.external_posting_id ?? null,
    });

    budget.remaining -= 1;
    try {
      const { sourcedPostingId } = await this.connector.createOrUpdate(payload, ctx);
      await this.postingStates.markLive({
        key,
        external_posting_id: sourcedPostingId,
        content_hash: contentHash,
      });
      if (action === 'CREATE') result.created += 1;
      else result.updated += 1;
    } catch (err) {
      await this.postingStates.markError(key);
      result.errors += 1;
      this.logger.warn({
        event: 'job_distribution_sync_posting_failed',
        tenant_id: req.tenant_id,
        requisition_id: req.id,
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async expirePosting(
    tenantId: string,
    state: ChannelPostingStateRow,
    budget: { remaining: number },
    result: JobDistributionSyncTickResult,
  ): Promise<void> {
    const key = {
      tenant_id: tenantId,
      requisition_id: state.requisition_id,
      channel: INDEED_CHANNEL,
    };
    // Never went live (no external id) → local tombstone only, no connector call.
    if (state.external_posting_id === null) {
      await this.postingStates.markExpired(key);
      result.expired += 1;
      return;
    }
    await this.postingStates.markPending({
      key,
      sync_status: 'PENDING_EXPIRE',
      content_hash: state.content_hash,
      external_posting_id: state.external_posting_id,
    });
    budget.remaining -= 1;
    try {
      await this.connector.expire(state.external_posting_id);
      await this.postingStates.markExpired(key);
      result.expired += 1;
    } catch (err) {
      await this.postingStates.markError(key);
      result.errors += 1;
      this.logger.warn({
        event: 'job_distribution_sync_expire_failed',
        tenant_id: tenantId,
        requisition_id: state.requisition_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The Indeed Apply loop back into SRC-1's dark webhook (RECON-3): postUrl carries
  // the tenant subdomain host (config.apply_host, e.g. "acme.aramo.ai") so the
  // inbound webhook resolves the tenant from Host; apiToken is the shared HMAC
  // secret (ARAMO_INDEED_APPLY_WEBHOOK_SECRET). Omitted when apply_host is unset or
  // the secret is unset (the job still posts; it simply carries no apply config).
  private buildApplyConfig(applyHost: string | null): IndeedApplyConfig | null {
    const secret = process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV];
    if (applyHost === null || applyHost.length === 0) return null;
    if (secret === undefined || secret.length === 0) return null;
    return {
      postUrl: `https://${applyHost}${INDEED_APPLY_WEBHOOK_PATH}`,
      apiToken: secret,
    };
  }
}

// Parse TenantChannelConfig.config (Json, non-secret per R5). employer_ids is
// REQUIRED (the Indeed employer association, provisioned at onboarding); its
// absence means the tenant is enabled but not yet postable → skip. source_name
// defaults to the tenant UUID (stable + unique — RECON-1: sourceName is immutable
// and unique per client). company_name defaults to source_name; country to 'US';
// apply_host is optional (its absence disables the apply loop for that tenant).
function parseIndeedConfig(
  raw: unknown,
  tenantId: string,
): ParsedIndeedConfig | null {
  const cfg = (raw ?? {}) as {
    employer_ids?: unknown;
    source_name?: unknown;
    company_name?: unknown;
    country?: unknown;
    apply_host?: unknown;
  };
  const employerIds = parseEmployerIds(cfg.employer_ids);
  if (employerIds.length === 0) return null;
  const sourceName =
    typeof cfg.source_name === 'string' && cfg.source_name.length > 0
      ? cfg.source_name
      : tenantId;
  const companyName =
    typeof cfg.company_name === 'string' && cfg.company_name.length > 0
      ? cfg.company_name
      : sourceName;
  const country =
    typeof cfg.country === 'string' && cfg.country.length > 0 ? cfg.country : 'US';
  const applyHost =
    typeof cfg.apply_host === 'string' && cfg.apply_host.length > 0
      ? cfg.apply_host
      : null;
  return { employerIds, sourceName, companyName, country, applyHost };
}

function parseEmployerIds(raw: unknown): IndeedEmployerId[] {
  if (!Array.isArray(raw)) return [];
  const out: IndeedEmployerId[] = [];
  for (const entry of raw) {
    const e = entry as { type?: unknown; id?: unknown };
    if (typeof e.type === 'string' && typeof e.id === 'string') {
      out.push({ type: e.type, id: e.id });
    }
  }
  return out;
}
