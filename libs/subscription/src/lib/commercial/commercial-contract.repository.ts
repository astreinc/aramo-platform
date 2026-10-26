import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import type { ContractAmendmentBlock, ContractEndBlock, ContractEvidenceDocument, ContractRecordBlock } from './commercial-contract.js';

// CCP-B4 (PBD §5.3 row B4; MP-A2 N-3) — the contract writes (called ONLY from inside the CCP-A6
// apply transaction; the DB insert guards refuse any other writer) and the read model (plan,
// version, commitment and state read THROUGH the governed TenantSubscription, N-3(c)/(d)).

function normalizedDocs(docs: ContractEvidenceDocument[]): ContractEvidenceDocument[] {
  return docs.map((d) => ({
    name: d.name,
    sha256: d.sha256,
    ...(d.byte_size === undefined ? {} : { byte_size: d.byte_size }),
    ...(d.media_type === undefined ? {} : { media_type: d.media_type }),
  }));
}

// ---- Writes (inside the A6 apply transaction only) ----------------------------------------

type TxLike = {
  contract: {
    findUnique: (a: { where: { id: string } | { tenant_subscription_id: string } }) => Promise<ContractRow | null>;
    create: (a: { data: ContractRow }) => Promise<unknown>;
  };
  contractAmendment: {
    aggregate: (a: { where: { contract_id: string }; _max: { sequence: true } }) => Promise<{ _max: { sequence: number | null } }>;
    // `terms` omitted = SQL NULL (a Prisma Json? column takes no plain null).
    create: (a: { data: Omit<ContractAmendmentRow, 'terms'> & { terms?: string[] } }) => Promise<unknown>;
  };
};

export interface ContractRow {
  id: string;
  contract_ref: string;
  tenant_subscription_id: string;
  terms: unknown;
  evidence_documents: unknown;
  evidence_ref: string | null;
  provenance: string;
  recorded_by_change_request_id: string;
  recorded_by: string;
  recorded_at: Date;
  // CCP-C8-PR (PR-1) — the structured payment terms (null on a contract recorded before C8-PR).
  billing_mode?: string | null;
  payment_currency?: string | null;
  payment_timezone?: string | null;
  grace_days?: number | null;
  postpaid_approval?: unknown;
}

export interface ContractAmendmentRow {
  id: string;
  contract_id: string;
  sequence: number;
  kind: string;
  summary: string;
  terms: unknown;
  evidence_documents: unknown;
  evidence_ref: string | null;
  change_request_id: string;
  recorded_by: string;
  recorded_at: Date;
}

/** Why a contract write cannot be applied (mapped by the apply service to an APPLY_FAILED code). */
export class ContractApplyConflict extends Error {
  constructor(
    readonly code: 'CONTRACT_ALREADY_RECORDED' | 'CONTRACT_REF_TAKEN' | 'CONTRACT_MISMATCH',
    readonly detail: Record<string, unknown>,
  ) {
    super(`contract apply conflict (${code})`);
    this.name = 'ContractApplyConflict';
  }
}

export interface ContractWriteContext {
  change_request_id: string;
  change_request_kind: string;
  requested_by: string;
  now: Date;
}

export interface ContractEffect {
  event_type: 'COMMERCIAL_CONTRACT_RECORDED' | 'COMMERCIAL_CONTRACT_AMENDED' | 'COMMERCIAL_CONTRACT_ENDED' | 'COMMERCIAL_PAYMENT_RECEIPT_LINKED';
  subject: string;
  payload: Record<string, unknown>;
  /** CCP-C8-PR — the contract written or amended (the obligations attach to it). */
  contract_id?: string;
}

/** The contract governing a subscription row, if any (read inside the apply transaction). */
export async function contractOfSubscription(tx: unknown, subscription_id: string): Promise<ContractRow | null> {
  return (tx as TxLike).contract.findUnique({ where: { tenant_subscription_id: subscription_id } });
}

export async function recordContractInTx(tx: unknown, subscription_id: string, block: ContractRecordBlock, ctx: ContractWriteContext): Promise<ContractEffect> {
  const t = tx as TxLike;
  const existing = await t.contract.findUnique({ where: { tenant_subscription_id: subscription_id } });
  if (existing !== null) throw new ContractApplyConflict('CONTRACT_ALREADY_RECORDED', { subscription_id, contract_id: existing.id, contract_ref: existing.contract_ref });
  const id = uuidv7();
  const docs = normalizedDocs(block.documents);
  try {
    await t.contract.create({
      data: {
        id,
        contract_ref: block.contract_ref,
        tenant_subscription_id: subscription_id,
        terms: [...block.terms],
        evidence_documents: docs,
        evidence_ref: block.evidence_ref ?? null,
        provenance: ctx.change_request_kind === 'MIGRATION' ? 'MIGRATION' : 'CHANGE_REQUEST',
        recorded_by_change_request_id: ctx.change_request_id,
        recorded_by: ctx.requested_by,
        recorded_at: ctx.now,
        // CCP-C8-PR (PR-1): the payment terms, immutable with the row (a Json? column takes no plain null).
        ...(block.payment_terms === undefined
          ? {}
          : {
              billing_mode: block.payment_terms.billing_mode,
              payment_currency: block.payment_terms.currency,
              payment_timezone: block.payment_terms.timezone,
              grace_days: block.payment_terms.grace_days ?? null,
              ...(block.payment_terms.postpaid_approval === undefined ? {} : { postpaid_approval: block.payment_terms.postpaid_approval }),
            }),
      },
    });
  } catch (e) {
    const err = e as { code?: string; message?: string; meta?: unknown };
    if ((err.code === 'P2002' || String(err.message ?? '').includes('duplicate key')) && (JSON.stringify(err.meta ?? {}) + String(err.message ?? '')).includes('contract_ref')) {
      throw new ContractApplyConflict('CONTRACT_REF_TAKEN', { contract_ref: block.contract_ref });
    }
    throw e;
  }
  return {
    event_type: 'COMMERCIAL_CONTRACT_RECORDED',
    subject: `contract:${id}`,
    payload: {
      contract_id: id,
      contract_ref: block.contract_ref,
      subscription_id,
      terms_count: block.terms.length,
      document_sha256: docs.map((d) => d.sha256),
      ...(block.payment_terms === undefined ? {} : { billing_mode: block.payment_terms.billing_mode, obligations_count: block.payment_terms.obligations.length, grace_days: block.payment_terms.grace_days ?? null, timezone: block.payment_terms.timezone }),
    },
    contract_id: id,
  };
}

async function nextSequence(t: TxLike, contract_id: string): Promise<number> {
  const agg = await t.contractAmendment.aggregate({ where: { contract_id }, _max: { sequence: true } });
  return (agg._max.sequence ?? 0) + 1;
}

export async function amendContractInTx(tx: unknown, subscription_id: string, block: ContractAmendmentBlock, ctx: ContractWriteContext): Promise<ContractEffect> {
  const t = tx as TxLike;
  const contract = await t.contract.findUnique({ where: { id: block.contract_id } });
  if (contract === null || contract.tenant_subscription_id !== subscription_id) {
    throw new ContractApplyConflict('CONTRACT_MISMATCH', { contract_id: block.contract_id, subscription_id, governs: contract?.tenant_subscription_id ?? null });
  }
  const sequence = await nextSequence(t, contract.id);
  const docs = normalizedDocs(block.documents);
  await t.contractAmendment.create({
    data: {
      id: uuidv7(),
      contract_id: contract.id,
      sequence,
      kind: 'AMENDMENT',
      summary: block.summary,
      ...(block.terms === undefined ? {} : { terms: [...block.terms] }),
      evidence_documents: docs,
      evidence_ref: block.evidence_ref ?? null,
      change_request_id: ctx.change_request_id,
      recorded_by: ctx.requested_by,
      recorded_at: ctx.now,
    },
  });
  return {
    event_type: 'COMMERCIAL_CONTRACT_AMENDED',
    subject: `contract:${contract.id}`,
    payload: { contract_id: contract.id, contract_ref: contract.contract_ref, sequence, terms_changed: block.terms !== undefined, payment_terms_changed: block.payment_terms !== undefined, document_sha256: docs.map((d) => d.sha256) },
    contract_id: contract.id,
  };
}

/**
 * The END evidence of a contract-linked row. A contract-linked SUBSCRIPTION_END MUST name the
 * contract (the approvers approved ending exactly it); a block naming another contract, or a
 * block on a row with no contract, is a mismatch.
 */
export async function endContractInTx(tx: unknown, subscription_id: string, block: ContractEndBlock | undefined, ctx: ContractWriteContext): Promise<ContractEffect | null> {
  const t = tx as TxLike;
  const contract = await t.contract.findUnique({ where: { tenant_subscription_id: subscription_id } });
  if (contract === null && block === undefined) return null;
  if (contract === null || block === undefined || block.contract_id !== contract.id) {
    throw new ContractApplyConflict('CONTRACT_MISMATCH', { subscription_id, contract_id: contract?.id ?? null, named_contract_id: block?.contract_id ?? null });
  }
  const sequence = await nextSequence(t, contract.id);
  const docs = normalizedDocs(block.documents);
  await t.contractAmendment.create({
    data: {
      id: uuidv7(),
      contract_id: contract.id,
      sequence,
      kind: 'END',
      summary: block.summary ?? 'Contract ended',
      evidence_documents: docs,
      evidence_ref: block.evidence_ref ?? null,
      change_request_id: ctx.change_request_id,
      recorded_by: ctx.requested_by,
      recorded_at: ctx.now,
    },
  });
  return {
    event_type: 'COMMERCIAL_CONTRACT_ENDED',
    subject: `contract:${contract.id}`,
    payload: { contract_id: contract.id, contract_ref: contract.contract_ref, sequence, subscription_id, document_sha256: docs.map((d) => d.sha256) },
  };
}

// ---- Read model ---------------------------------------------------------------------------

/** Derived from the referenced TenantSubscription (never stored, N-3(d)). */
export type ContractStatus = 'ACTIVE' | 'ENDED';

export interface ContractPerson {
  user_id: string;
  display_name: string | null;
  email: string | null;
}

export interface ContractDocumentView extends ContractEvidenceDocument {
  recorded_by: ContractPerson;
  recorded_at: Date;
  /** null = recorded with the contract; n = recorded with amendment n. */
  amendment_sequence: number | null;
}

export interface ContractAmendmentView {
  sequence: number;
  kind: 'AMENDMENT' | 'END';
  summary: string;
  terms: string[] | null;
  documents: ContractEvidenceDocument[];
  evidence_ref: string | null;
  change_request_id: string;
  recorded_by: ContractPerson;
  recorded_at: Date;
}

export interface ContractSummaryView {
  id: string;
  contract_ref: string;
  tenant: { id: string; name: string; slug: string | null };
  product_key: string;
  /** Derived: ENDED when the governed subscription row has ended. */
  status: ContractStatus;
  subscription: {
    id: string;
    source: string;
    status: string;
    ended_at: Date | null;
    commitment_start: Date | null;
    commitment_end: Date | null;
    plan: { key: string; name: string };
    plan_version: { id: string; version_number: number; status: string };
  };
  provenance: 'CHANGE_REQUEST' | 'MIGRATION';
  recorded_at: Date;
}

export interface ContractDetailView extends ContractSummaryView {
  /** The current negotiated terms: the latest amendment's terms, else the recorded terms. */
  terms: string[];
  recorded_terms: string[];
  evidence_ref: string | null;
  recorded_by: ContractPerson;
  recorded_by_change_request_id: string;
  documents: ContractDocumentView[];
  amendments: ContractAmendmentView[];
  /** PBD §10 — contract invoicing waits on the enterprise invoicing choice. */
  invoicing: { enabled: false; reason: 'enterprise_invoicing_choice_pending' };
}

interface SummaryRaw {
  id: string;
  contract_ref: string;
  provenance: 'CHANGE_REQUEST' | 'MIGRATION';
  recorded_at: Date;
  terms: unknown;
  evidence_documents: unknown;
  evidence_ref: string | null;
  recorded_by: string;
  recorded_by_change_request_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string | null;
  product_key: string;
  subscription_id: string;
  source: string;
  sub_status: string;
  ended_at: Date | null;
  commitment_start: Date | null;
  commitment_end: Date | null;
  plan_key: string;
  plan_name: string;
  plan_version_id: string;
  version_number: number;
  version_status: string;
}

// The plan, version, commitment and state are read THROUGH the governed subscription row
// (N-3(c)); the tenant name is a read of identity."Tenant" (precedent: the A6 apply).
const SUMMARY_SQL = `
  SELECT c.id::text AS id, c.contract_ref, c.provenance, c.recorded_at, c.terms, c.evidence_documents, c.evidence_ref,
         c.recorded_by::text AS recorded_by, c.recorded_by_change_request_id::text AS recorded_by_change_request_id,
         s.tenant_id::text AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, s.product_key,
         s.id::text AS subscription_id, s.source, s.status AS sub_status, s.ended_at, s.commitment_start, s.commitment_end,
         p.key AS plan_key, p.name AS plan_name, v.id::text AS plan_version_id, v.version_number, v.status AS version_status
    FROM subscription."Contract" c
    JOIN subscription."TenantSubscription" s ON s.id = c.tenant_subscription_id
    JOIN subscription."Plan" p ON p.id = s.plan_id
    JOIN subscription."PlanVersion" v ON v.id = s.plan_version_id
    JOIN identity."Tenant" t ON t.id = s.tenant_id`;

export const CONTRACT_LIST_DEFAULT_LIMIT = 100;
export const CONTRACT_LIST_MAX_LIMIT = 200;

function summaryOf(r: SummaryRaw): ContractSummaryView {
  return {
    id: r.id,
    contract_ref: r.contract_ref,
    tenant: { id: r.tenant_id, name: r.tenant_name, slug: r.tenant_slug },
    product_key: r.product_key,
    status: r.ended_at === null ? 'ACTIVE' : 'ENDED',
    subscription: {
      id: r.subscription_id,
      source: r.source,
      status: r.sub_status,
      ended_at: r.ended_at,
      commitment_start: r.commitment_start,
      commitment_end: r.commitment_end,
      plan: { key: r.plan_key, name: r.plan_name },
      plan_version: { id: r.plan_version_id, version_number: r.version_number, status: r.version_status },
    },
    provenance: r.provenance,
    recorded_at: r.recorded_at,
  };
}

@Injectable()
export class ContractRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Active contracts first, then the most recently recorded. Optional tenant filter. */
  async list(query: { tenant_id?: string; status?: ContractStatus; limit?: number } = {}): Promise<ContractSummaryView[]> {
    const limit = Math.min(Math.max(query.limit ?? CONTRACT_LIST_DEFAULT_LIMIT, 1), CONTRACT_LIST_MAX_LIMIT);
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.tenant_id !== undefined) {
      params.push(query.tenant_id);
      where.push(`s.tenant_id = $${params.length}::uuid`);
    }
    if (query.status !== undefined) where.push(query.status === 'ACTIVE' ? 's.ended_at IS NULL' : 's.ended_at IS NOT NULL');
    params.push(limit);
    const sql = `${SUMMARY_SQL} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (s.ended_at IS NULL) DESC, c.recorded_at DESC, c.id DESC LIMIT $${params.length}`;
    const rows = await this.prisma.$queryRawUnsafe<SummaryRaw[]>(sql, ...params);
    return rows.map(summaryOf);
  }

  async get(id: string): Promise<ContractDetailView | null> {
    const rows = await this.prisma.$queryRawUnsafe<SummaryRaw[]>(`${SUMMARY_SQL} WHERE c.id = $1::uuid`, id);
    const r = rows[0];
    if (r === undefined) return null;
    const amendments = (await this.prisma.contractAmendment.findMany({ where: { contract_id: id }, orderBy: { sequence: 'asc' } })) as ContractAmendmentRow[];
    const people = await this.people([r.recorded_by, ...amendments.map((a) => a.recorded_by)]);
    const who = (uid: string): ContractPerson => people.get(uid) ?? { user_id: uid, display_name: null, email: null };
    const recorded_terms = r.terms as string[];
    const latestTerms = [...amendments].reverse().find((a) => a.terms !== null)?.terms as string[] | undefined;
    const docsOf = (v: unknown): ContractEvidenceDocument[] => (Array.isArray(v) ? (v as ContractEvidenceDocument[]) : []);
    const documents: ContractDocumentView[] = [
      ...docsOf(r.evidence_documents).map((d) => ({ ...d, recorded_by: who(r.recorded_by), recorded_at: r.recorded_at, amendment_sequence: null })),
      ...amendments.flatMap((a) => docsOf(a.evidence_documents).map((d) => ({ ...d, recorded_by: who(a.recorded_by), recorded_at: a.recorded_at, amendment_sequence: a.sequence }))),
    ];
    return {
      ...summaryOf(r),
      terms: latestTerms ?? recorded_terms,
      recorded_terms,
      evidence_ref: r.evidence_ref,
      recorded_by: who(r.recorded_by),
      recorded_by_change_request_id: r.recorded_by_change_request_id,
      documents,
      amendments: amendments.map((a) => ({
        sequence: a.sequence,
        kind: a.kind as 'AMENDMENT' | 'END',
        summary: a.summary,
        terms: (a.terms as string[] | null) ?? null,
        documents: docsOf(a.evidence_documents),
        evidence_ref: a.evidence_ref,
        change_request_id: a.change_request_id,
        recorded_by: who(a.recorded_by),
        recorded_at: a.recorded_at,
      })),
      invoicing: { enabled: false, reason: 'enterprise_invoicing_choice_pending' },
    };
  }

  private async people(ids: string[]): Promise<Map<string, ContractPerson>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; display_name: string | null; email: string | null }>>(
      `SELECT id::text AS id, display_name, email FROM identity."User" WHERE id = ANY($1::uuid[])`,
      unique,
    );
    return new Map(rows.map((u) => [u.id, { user_id: u.id, display_name: u.display_name, email: u.email }]));
  }
}
