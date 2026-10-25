import { Injectable } from '@nestjs/common';

import { type PlanVersionContent, type PlanVersionStatus, planVersionTerms } from '../plan-version.js';
import { PlanVersionDraftExistsError, PlanVersionRepository, PlanVersionStateError, type PlanVersionRow } from '../plan-version.repository.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BASE_COMPOSITION, PRODUCT_KEYS, type ProductKey } from '../product-registry.js';

import { CommercialAuditRepository } from './commercial-audit.repository.js';
import {
  CatalogDraftEditError,
  type CatalogConflictReason,
  type CatalogDraftEdits,
  type CatalogVersionTerms,
  applyCatalogDraftEdits,
  catalogTermsOf,
} from './commercial-catalog.js';
import { COMMERCIAL_OPEN_STATES, resolveRequiredChain, type CommercialChainRule } from './commercial-change-request.js';
import type { CommercialActor, CommercialCallContext } from './commercial-change-request.service.js';
import { CommercialOperatorRepository } from './commercial-operator.repository.js';
import { CommercialPolicyRepository } from './commercial-policy.repository.js';

// CCP-B2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B2; MP-A2 N-15…N-18) — the
// product and plan catalog the platform console reads, and the ONLY catalog writes the console
// makes: creating and editing a DRAFT plan version.
//
//   read          the closed product registry (v1: sign), its plans, every version with its
//                 terms, the open-subscription pin count per version (grandfathering: a
//                 subscription keeps its pinned version), and the open PLAN_VERSION_PUBLISH /
//                 PLAN_RETIRE change requests that target each version.
//   draft         `platform:catalog:draft`, a human principal: a new DRAFT copied from a named
//                 version of the same plan (one DRAFT per plan), or an edit of a DRAFT's price,
//                 envelopes per month or storage. A PUBLISHED or RETIRED version is NEVER
//                 edited (repository refusal + the N-16 DB trigger): a change of terms is a new
//                 version. Each write appends a CommercialAuditEvent in its transaction.
//   NOT here      publish, retire, pin. Those are commercial changes: the console submits a
//                 PLAN_VERSION_PUBLISH / PLAN_RETIRE change request (CCP-A3; Finance → Owner),
//                 and CCP-A6 applies an approved one (PlanVersionRepository.publish / retire).

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export const CATALOG_DRAFT_SCOPE = 'platform:catalog:draft';
export const CATALOG_ACTION_TYPES = ['PLAN_VERSION_PUBLISH', 'PLAN_RETIRE'] as const;
export type CatalogActionType = (typeof CATALOG_ACTION_TYPES)[number];

export type CommercialCatalogErrorCode = 'NOT_FOUND' | 'NOT_HUMAN' | 'SCOPE_MISSING' | 'CONFLICT' | 'INVALID_INPUT';

export class CommercialCatalogError extends Error {
  constructor(
    readonly code: CommercialCatalogErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CommercialCatalogError';
  }
}

export interface CatalogOpenRequest {
  id: string;
  action_type: CatalogActionType;
  state: string;
  expires_at: Date | null;
}

export interface CatalogVersionSummary {
  id: string;
  plan_id: string;
  version_number: number;
  status: PlanVersionStatus;
  content_checksum: string;
  note: string | null;
  created_by: string;
  created_at: Date;
  published_at: Date | null;
  retired_at: Date | null;
  terms: CatalogVersionTerms;
  /** Open BASE subscriptions pinned to this version. */
  pinned_subscriptions: number;
  open_requests: CatalogOpenRequest[];
}

export interface CatalogPlanView {
  id: string;
  key: string;
  product_key: ProductKey;
  name: string;
  status: string;
  sales_model: string;
  sellable: boolean;
  display_order: number;
  /** Newest first. */
  versions: CatalogVersionSummary[];
}

export interface CatalogProductView {
  product_key: ProductKey;
  plans: CatalogPlanView[];
}

export interface CatalogChainPreview {
  rule: CommercialChainRule;
  step_role_keys: string[];
  policy_version_id: string;
  policy_version_number: number;
  approval_expiry_hours: number;
}

export interface CatalogView {
  products: CatalogProductView[];
  /** The chain a publish or retire request gets under the ACTIVE policy; null if none is valid. */
  publish_chain: CatalogChainPreview | null;
}

export interface CatalogPinnedTenant {
  tenant_id: string;
  name: string;
}

export interface CatalogVersionDetail {
  version: CatalogVersionSummary;
  plan: Omit<CatalogPlanView, 'versions'>;
  content: PlanVersionContent;
  pinned_tenants: CatalogPinnedTenant[];
}

export interface CreateDraftInput {
  from_version_id: string;
  note?: string | null;
}

export interface UpdateDraftInput {
  /** The content checksum the editor read (optimistic concurrency). */
  expected_content_checksum: string;
  edits: CatalogDraftEdits;
  note?: string | null;
}

const productKeys = (): ProductKey[] => [...PRODUCT_KEYS];

@Injectable()
export class CommercialCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versions: PlanVersionRepository,
    private readonly policies: CommercialPolicyRepository,
    private readonly audit: CommercialAuditRepository,
    private readonly operators: CommercialOperatorRepository,
  ) {}

  // ---- read -------------------------------------------------------------------------------

  async readCatalog(now: Date = new Date()): Promise<CatalogView> {
    const plans = await this.prisma.plan.findMany({ where: { product_key: { in: productKeys() } }, orderBy: [{ display_order: 'asc' }, { key: 'asc' }] });
    const rows = (await this.prisma.planVersion.findMany({ where: { plan_id: { in: plans.map((p) => p.id) } }, orderBy: [{ version_number: 'desc' }] })) as PlanVersionRow[];
    const pins = await this.pinCounts(rows.map((r) => r.id));
    const open = await this.openCatalogRequests(now);
    const products: CatalogProductView[] = productKeys().map((product_key) => ({
      product_key,
      plans: plans
        .filter((p) => p.product_key === product_key)
        .map((p) => ({
          ...planOf(p),
          versions: rows.filter((r) => r.plan_id === p.id).map((r) => summaryOf(r, pins.get(r.id) ?? 0, open.get(r.id) ?? [])),
        })),
    }));
    return { products, publish_chain: await this.publishChain() };
  }

  async readVersion(version_id: string, now: Date = new Date()): Promise<CatalogVersionDetail> {
    const row = (await this.prisma.planVersion.findUnique({ where: { id: version_id } })) as PlanVersionRow | null;
    if (row === null) throw new CommercialCatalogError('NOT_FOUND', 'plan version not found', { version_id });
    const plan = await this.prisma.plan.findUnique({ where: { id: row.plan_id } });
    if (plan === null || !(PRODUCT_KEYS as readonly string[]).includes(plan.product_key)) throw new CommercialCatalogError('NOT_FOUND', 'plan version not found', { version_id });
    const pins = await this.pinCounts([row.id]);
    const open = await this.openCatalogRequests(now);
    const tenants = await this.prisma.$queryRawUnsafe<Array<{ tenant_id: string; name: string }>>(
      `SELECT s.tenant_id::text AS tenant_id, t.name AS name
         FROM subscription."TenantSubscription" s
         JOIN identity."Tenant" t ON t.id = s.tenant_id
        WHERE s.plan_version_id = $1::uuid AND s.ended_at IS NULL AND s.composition_role = $2
        ORDER BY t.name ASC, s.tenant_id ASC`,
      row.id,
      BASE_COMPOSITION,
    );
    return {
      version: summaryOf(row, pins.get(row.id) ?? 0, open.get(row.id) ?? []),
      plan: planOf(plan),
      content: planVersionTerms(row),
      pinned_tenants: tenants.map((t) => ({ tenant_id: t.tenant_id, name: t.name })),
    };
  }

  // ---- draft writes -----------------------------------------------------------------------

  /** A new DRAFT of `plan_id`, copied from one of its versions. One DRAFT per plan. */
  async createDraft(actor: CommercialActor, plan_id: string, input: CreateDraftInput, ctx: CommercialCallContext): Promise<CatalogVersionSummary> {
    this.assertDrafter(actor);
    const source = (await this.prisma.planVersion.findUnique({ where: { id: input.from_version_id } })) as PlanVersionRow | null;
    if (source === null) throw new CommercialCatalogError('NOT_FOUND', 'source plan version not found', { from_version_id: input.from_version_id });
    if (source.plan_id !== plan_id) throw conflict('plan_mismatch', 'the source version belongs to another plan', { from_version_id: input.from_version_id, plan_id });
    const plan = await this.prisma.plan.findUnique({ where: { id: plan_id } });
    if (plan === null || !(PRODUCT_KEYS as readonly string[]).includes(plan.product_key)) throw new CommercialCatalogError('NOT_FOUND', 'plan not found', { plan_id });
    const content = planVersionTerms(source);
    const policy = await this.policies.getActivePolicy();
    try {
      const row = await this.tx(async (tx) => {
        const created = await this.versions.createDraft({ plan_id, content, created_by: actor.user_id, note: input.note ?? null, exclusive: true }, tx);
        await this.audited(tx, actor, ctx, policy.version_id, 'COMMERCIAL_PLAN_VERSION_DRAFTED', created, {
          plan_key: plan.key,
          product_key: plan.product_key,
          from_version_id: source.id,
          from_version_number: source.version_number,
        });
        return created;
      });
      return summaryOf(row, 0, []);
    } catch (e) {
      if (e instanceof PlanVersionDraftExistsError) throw conflict('draft_exists', 'the plan already has a draft version', { draft_id: e.draft_id });
      throw e;
    }
  }

  /** Edits a DRAFT's price, envelopes per month or storage. Never a PUBLISHED or RETIRED version. */
  async updateDraft(actor: CommercialActor, version_id: string, input: UpdateDraftInput, ctx: CommercialCallContext): Promise<CatalogVersionSummary> {
    this.assertDrafter(actor);
    const policy = await this.policies.getActivePolicy();
    try {
      const row = await this.tx(async (tx) => {
        const current = (await tx.planVersion.findUnique({ where: { id: version_id } })) as PlanVersionRow | null;
        if (current === null) throw new CommercialCatalogError('NOT_FOUND', 'plan version not found', { version_id });
        const plan = await tx.plan.findUnique({ where: { id: current.plan_id } });
        if (plan === null || !(PRODUCT_KEYS as readonly string[]).includes(plan.product_key)) throw new CommercialCatalogError('NOT_FOUND', 'plan version not found', { version_id });
        if (current.status !== 'DRAFT') {
          throw conflict('not_draft', `plan version ${version_id} is ${current.status}: a published version is immutable; a change of terms is a new draft`, { status: current.status });
        }
        if (current.content_checksum !== input.expected_content_checksum) throw conflict('stale', 'the draft changed since it was read', { content_checksum: current.content_checksum });
        const next = applyCatalogDraftEdits(planVersionTerms(current), input.edits);
        const updated = await this.versions.updateDraft(version_id, next, input.note, tx);
        await this.audited(tx, actor, ctx, policy.version_id, 'COMMERCIAL_PLAN_VERSION_DRAFT_UPDATED', updated, {
          plan_key: plan.key,
          product_key: plan.product_key,
          from_checksum: current.content_checksum,
          edited: Object.keys(input.edits).sort(),
        });
        return updated;
      });
      const pins = await this.pinCounts([row.id]);
      return summaryOf(row, pins.get(row.id) ?? 0, (await this.openCatalogRequests(new Date())).get(row.id) ?? []);
    } catch (e) {
      if (e instanceof CatalogDraftEditError) throw conflict(e.reason, e.message, e.detail);
      // A concurrent publish between the read and the write: the repository (and the N-16
      // trigger) refuse; report it as the same not_draft conflict.
      if (e instanceof PlanVersionStateError) throw conflict('not_draft', e.message);
      throw e;
    }
  }

  // ---- internals --------------------------------------------------------------------------

  private assertDrafter(actor: CommercialActor): void {
    if (actor.actor_kind !== 'user') throw new CommercialCatalogError('NOT_HUMAN', 'only a user principal drafts a plan version');
    if (!actor.scopes.includes(CATALOG_DRAFT_SCOPE)) throw new CommercialCatalogError('SCOPE_MISSING', `drafting a plan version requires ${CATALOG_DRAFT_SCOPE}`, { missing_scopes: [CATALOG_DRAFT_SCOPE] });
  }

  private async audited(
    tx: Tx,
    actor: CommercialActor,
    ctx: CommercialCallContext,
    policy_version_id: string,
    event_type: string,
    row: PlanVersionRow,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const live = await this.operators.readOperator(tx, ctx.platform_tenant_id, actor.user_id);
    await this.audit.append(
      {
        actor: { id: actor.user_id, type: 'user', role_keys: live.role_keys },
        event_type,
        subject: `plan_version:${row.id}`,
        policy_version_id,
        payload: { plan_id: row.plan_id, version_number: row.version_number, content_checksum: row.content_checksum, ...extra },
        correlation_id: ctx.correlation_id,
      },
      tx,
    );
  }

  private async pinCounts(version_ids: readonly string[]): Promise<Map<string, number>> {
    if (version_ids.length === 0) return new Map();
    const groups = await this.prisma.tenantSubscription.groupBy({
      by: ['plan_version_id'],
      where: { plan_version_id: { in: [...version_ids] }, ended_at: null, composition_role: BASE_COMPOSITION },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.plan_version_id, g._count._all]));
  }

  /** Open (and not lazily expired) catalog change requests, by target plan version. */
  private async openCatalogRequests(now: Date): Promise<Map<string, CatalogOpenRequest[]>> {
    const rows = await this.prisma.commercialChangeRequest.findMany({
      where: { action_type: { in: [...CATALOG_ACTION_TYPES] }, state: { in: [...COMMERCIAL_OPEN_STATES] } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { id: true, action_type: true, state: true, payload: true, expires_at: true },
    });
    const out = new Map<string, CatalogOpenRequest[]>();
    for (const r of rows) {
      if (r.state === 'PENDING_APPROVAL' && r.expires_at !== null && r.expires_at.getTime() <= now.getTime()) continue;
      const target = (r.payload as Record<string, unknown> | null)?.['plan_version_id'];
      if (typeof target !== 'string') continue;
      const list = out.get(target) ?? [];
      list.push({ id: r.id, action_type: r.action_type as CatalogActionType, state: r.state, expires_at: r.expires_at });
      out.set(target, list);
    }
    return out;
  }

  private async publishChain(): Promise<CatalogChainPreview | null> {
    try {
      const policy = await this.policies.getActivePolicy();
      const chain = resolveRequiredChain('PLAN_VERSION_PUBLISH', {}, policy.content);
      return {
        rule: chain.rule,
        step_role_keys: chain.steps.map((s) => s.role_key),
        policy_version_id: policy.version_id,
        policy_version_number: policy.version_number,
        approval_expiry_hours: policy.content.approval_expiry_hours,
      };
    } catch {
      return null;
    }
  }

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { timeout: 15_000, maxWait: 10_000 });
  }
}

function conflict(reason: CatalogConflictReason, message: string, details: Record<string, unknown> = {}): CommercialCatalogError {
  return new CommercialCatalogError('CONFLICT', message, { reason, ...details });
}

function planOf(p: { id: string; key: string; product_key: string; name: string; status: string; sales_model: string; sellable: boolean; display_order: number }): Omit<CatalogPlanView, 'versions'> {
  return { id: p.id, key: p.key, product_key: p.product_key as ProductKey, name: p.name, status: p.status, sales_model: p.sales_model, sellable: p.sellable, display_order: p.display_order };
}

function summaryOf(r: PlanVersionRow, pinned: number, open: CatalogOpenRequest[]): CatalogVersionSummary {
  return {
    id: r.id,
    plan_id: r.plan_id,
    version_number: r.version_number,
    status: r.status,
    content_checksum: r.content_checksum,
    note: r.note,
    created_by: r.created_by,
    created_at: r.created_at,
    published_at: r.published_at,
    retired_at: r.retired_at,
    terms: catalogTermsOf(planVersionTerms(r)),
    pinned_subscriptions: pinned,
    open_requests: open,
  };
}
