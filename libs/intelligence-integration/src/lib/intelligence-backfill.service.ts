import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { v5 as uuidv5 } from 'uuid';
import { EntitlementRepository } from '@aramo/entitlement';
import type { TalentIngestRequest } from '@aramo/intelligence-contracts';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import { TalentIntelligenceRepository, type AdmissibleTalentRecord } from '@aramo/talent-record';

import { IngestPayloadRejectedError, buildTalentIngestRequest } from './ingest-payload-builder.js';
import { IntelligenceClient, IntelligenceRejectedError, IntelligenceUnavailableError } from './intelligence-client.js';
import { IntelligenceEntitlementSyncService } from './intelligence-entitlement-sync.service.js';
import { fieldKeysOfColumns } from './sync-policy.js';

// ATI-SEP-1 (ADR-0036 "Operations — backfill") — the Talent Intelligence
// BACKFILL. TI is a clean rebuild: it starts EMPTY and is populated by replaying
// the COMMITTED ATS data of every tenant holding the `intelligence` capability.
// HTTP only (the A7 wall) — the same client, the same admission builder and the
// same allowlisted reads as the outbox publisher; nothing here is on an ATS
// request path and nothing runs automatically (operator CLI only).
//
//   1. resolve tenants — every entitled tenant, or an explicit list (a listed
//      tenant WITHOUT the capability is refused and counted not_entitled);
//   2. full REPLACE entitlement sync (so TI holds exactly the entitled set ACTIVE);
//   3. per tenant, keyset-page LIVE TalentRecords by id; for each, build the
//      admission payload (fail closed) and POST /v1/ingest/talent with a
//      DETERMINISTIC source_event_id:
//        uuidv5('backfill:v1:<tenant>:<talent>:<sha256 of the built identity +
//        assertions>', BACKFILL_NAMESPACE)
//      so a re-run over unchanged data is idempotent through TI's inbox
//      (replayed:true counts as success), while a changed record gets a new id
//      and is re-ingested as a fresh snapshot;
//   4. link the returned Golden subject (intelligence_link), as the publisher does.
//
// Failure handling: TI unavailable (network / timeout / 5xx / 429) → retried with
// exponential backoff, then counted failed; a builder (validator) or TI 4xx
// refusal → skipped and recorded by REASON CODE ONLY. Logs carry ids, codes and
// counts — never a payload value. Resumable: a checkpoint line after every page
// carries the cursor; pass it back as `after`.

/** Fixed uuidv5 namespace of the backfill's source_event_ids (never change: it is the idempotency key space). */
export const BACKFILL_EVENT_NAMESPACE = '6f1c7a52-3d0e-5b8a-9c41-2a7e0b9d4f13';
export const BACKFILL_KEY_VERSION = 'v1';

export const DEFAULT_BACKFILL_CONCURRENCY = 4;
export const DEFAULT_BACKFILL_PAGE_SIZE = 200;
export const DEFAULT_BACKFILL_MAX_ATTEMPTS = 5;
export const DEFAULT_BACKFILL_BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Placeholder id used only while hashing the built content (replaced before sending). */
const HASH_PLACEHOLDER_EVENT_ID = '00000000-0000-4000-8000-000000000000';

export interface BackfillOptions {
  /** Explicit tenants (each still refused unless entitled). Omitted → every entitled tenant. */
  tenants?: readonly string[];
  /** Resume cursor: process records with id strictly greater (requires exactly one tenant). */
  after?: string | null;
  /** Build + validate only; no TI call, no link write. */
  dryRun?: boolean;
  /** Max records scanned across the run. */
  limit?: number;
  concurrency?: number;
  pageSize?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

export interface BackfillRejection {
  tenant_id: string;
  talent_id: string;
  code: string;
}

export interface BackfillSummary {
  dry_run: boolean;
  tenants: string[];
  scanned: number;
  ingested: number;
  replayed: number;
  /** dry-run only: payloads that built + validated. */
  validated: number;
  rejected: number;
  rejected_by_code: Record<string, number>;
  failed: number;
  /** Explicitly-listed tenants refused for lacking the capability. */
  not_entitled: number;
  /** Last fully-processed record id per tenant (resume cursor). */
  cursors: Record<string, string | null>;
  rejections: BackfillRejection[];
}

export class BackfillRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackfillRefusedError';
  }
}

/** The deterministic source_event_id of one record's content. */
export function backfillEventId(tenantId: string, talentId: string, contentHash: string): string {
  return uuidv5(`backfill:${BACKFILL_KEY_VERSION}:${tenantId}:${talentId}:${contentHash}`, BACKFILL_EVENT_NAMESPACE);
}

/** sha256 of the built content (identity + assertions — not the event id / occurred_at). */
export function backfillContentHash(request: Pick<TalentIngestRequest, 'identity' | 'assertions'>): string {
  return createHash('sha256').update(JSON.stringify({ identity: request.identity, assertions: request.assertions }), 'utf8').digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ItemOutcome = { kind: 'ingested' | 'replayed' | 'validated' } | { kind: 'rejected'; code: string } | { kind: 'failed'; code: string };

@Injectable()
export class IntelligenceBackfillService {
  private readonly logger = new Logger('IntelligenceBackfill');

  constructor(
    private readonly client: IntelligenceClient,
    private readonly entitlements: EntitlementRepository,
    private readonly entitlementSync: IntelligenceEntitlementSyncService,
    private readonly records: TalentIntelligenceRepository,
    private readonly evidence: TalentEvidenceRepository,
  ) {}

  /** Overridable for tests. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async run(opts: BackfillOptions = {}): Promise<BackfillSummary> {
    const dryRun = opts.dryRun === true;
    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_BACKFILL_CONCURRENCY));
    const pageSize = Math.max(1, Math.floor(opts.pageSize ?? DEFAULT_BACKFILL_PAGE_SIZE));
    const limit = opts.limit !== undefined ? Math.max(0, Math.floor(opts.limit)) : Number.POSITIVE_INFINITY;

    if (!dryRun && !this.client.configured) {
      throw new BackfillRefusedError('TI_NOT_CONFIGURED', 'Talent Intelligence is not configured — set INTELLIGENCE_SERVICE_URL / INTELLIGENCE_ATS_CLIENT_ID / INTELLIGENCE_ATS_CLIENT_SECRET');
    }
    for (const t of opts.tenants ?? []) {
      if (!UUID.test(t)) throw new BackfillRefusedError('INVALID_TENANT', `tenant id is not a uuid: ${t}`);
    }
    if (opts.after !== undefined && opts.after !== null) {
      if (!UUID.test(opts.after)) throw new BackfillRefusedError('INVALID_CURSOR', 'after must be a talent record uuid');
      if (opts.tenants?.length !== 1) throw new BackfillRefusedError('CURSOR_NEEDS_ONE_TENANT', 'after requires exactly one explicit tenant');
    }

    const summary: BackfillSummary = {
      dry_run: dryRun,
      tenants: [],
      scanned: 0,
      ingested: 0,
      replayed: 0,
      validated: 0,
      rejected: 0,
      rejected_by_code: {},
      failed: 0,
      not_entitled: 0,
      cursors: {},
      rejections: [],
    };

    // 1. tenants
    const entitled = new Set(await this.entitlements.listTenantIdsWithCapability('intelligence'));
    let tenants: string[];
    if (opts.tenants !== undefined && opts.tenants.length > 0) {
      tenants = [];
      for (const t of [...new Set(opts.tenants)]) {
        if (entitled.has(t)) tenants.push(t);
        else {
          summary.not_entitled += 1;
          this.logger.warn({ event: 'intelligence_backfill_tenant_not_entitled', tenant_id: t });
        }
      }
    } else {
      tenants = [...entitled].sort();
    }
    summary.tenants = tenants;

    // 2. entitlement REPLACE (authoritative) before any ingest.
    if (!dryRun && tenants.length > 0) {
      const replaced = await this.entitlementSync.replaceAll();
      if (replaced === null) {
        throw new BackfillRefusedError('ENTITLEMENT_SYNC_REFUSED', 'the full REPLACE entitlement sync was refused (see intelligence_entitlement_replace_refused)');
      }
    }
    this.logger.log({ event: 'intelligence_backfill_started', dry_run: dryRun, tenants: tenants.length, not_entitled: summary.not_entitled, concurrency, page_size: pageSize });

    // 3. per tenant keyset paging
    for (const tenantId of tenants) {
      let after: string | null = opts.after ?? null;
      summary.cursors[tenantId] = after;
      while (summary.scanned < limit) {
        const take = Math.min(pageSize, limit - summary.scanned);
        const page = await this.records.listLiveAdmissibleRecordsPage({ tenant_id: tenantId, after, limit: take });
        if (page.length === 0) break;
        summary.scanned += page.length;
        const outcomes = await this.pool(page, concurrency, (r) => this.processOne(r, dryRun, opts));
        page.forEach((record, i) => this.tally(summary, record, outcomes[i] as ItemOutcome));
        after = (page[page.length - 1] as AdmissibleTalentRecord).id;
        summary.cursors[tenantId] = after;
        this.logger.log({
          event: 'intelligence_backfill_checkpoint',
          tenant_id: tenantId,
          after,
          scanned: summary.scanned,
          ingested: summary.ingested,
          replayed: summary.replayed,
          validated: summary.validated,
          rejected: summary.rejected,
          failed: summary.failed,
        });
        if (page.length < take) break;
      }
    }

    this.logger.log({
      event: 'intelligence_backfill_done',
      dry_run: dryRun,
      tenants: tenants.length,
      scanned: summary.scanned,
      ingested: summary.ingested,
      replayed: summary.replayed,
      validated: summary.validated,
      rejected: summary.rejected,
      rejected_by_code: summary.rejected_by_code,
      failed: summary.failed,
      not_entitled: summary.not_entitled,
    });
    return summary;
  }

  private tally(summary: BackfillSummary, record: AdmissibleTalentRecord, o: ItemOutcome): void {
    switch (o.kind) {
      case 'ingested':
        summary.ingested += 1;
        return;
      case 'replayed':
        summary.replayed += 1;
        return;
      case 'validated':
        summary.validated += 1;
        return;
      case 'rejected':
        summary.rejected += 1;
        summary.rejected_by_code[o.code] = (summary.rejected_by_code[o.code] ?? 0) + 1;
        summary.rejections.push({ tenant_id: record.tenant_id, talent_id: record.id, code: o.code });
        this.logger.warn({ event: 'intelligence_backfill_rejected', tenant_id: record.tenant_id, talent_id: record.id, code: o.code });
        return;
      case 'failed':
        summary.failed += 1;
        this.logger.error({ event: 'intelligence_backfill_failed', tenant_id: record.tenant_id, talent_id: record.id, code: o.code });
        return;
    }
  }

  /** Build the payload exactly as the publisher does, with the deterministic event id. */
  async buildRequest(record: AdmissibleTalentRecord): Promise<TalentIngestRequest> {
    const [evidence, tiSourced] = await Promise.all([
      this.evidence.readEvidenceForIntelligence({ tenant_id: record.tenant_id, talent_id: record.id }),
      this.records.listIntelligenceSourcedFields(record.id),
    ]);
    const occurredAt = record.updated_at.toISOString();
    const { request } = buildTalentIngestRequest({
      source_event_id: HASH_PLACEHOLDER_EVENT_ID,
      occurred_at: occurredAt,
      record,
      evidence,
      intelligence_sourced_fields: fieldKeysOfColumns(tiSourced),
    });
    return { ...request, source_event_id: backfillEventId(record.tenant_id, record.id, backfillContentHash(request)) };
  }

  private async processOne(record: AdmissibleTalentRecord, dryRun: boolean, opts: BackfillOptions): Promise<ItemOutcome> {
    let request: TalentIngestRequest;
    try {
      request = await this.buildRequest(record);
    } catch (err) {
      if (err instanceof IngestPayloadRejectedError) return { kind: 'rejected', code: `VALIDATOR_${err.issues[0]?.code ?? 'UNKNOWN'}` };
      return { kind: 'failed', code: 'READ_FAILED' };
    }
    if (dryRun) return { kind: 'validated' };

    const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_BACKFILL_MAX_ATTEMPTS);
    const base = Math.max(0, opts.baseBackoffMs ?? DEFAULT_BACKFILL_BASE_BACKOFF_MS);
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.client.ingestTalent(request);
        await this.records.upsertLink({
          tenant_id: record.tenant_id,
          talent_record_id: record.id,
          intelligence_subject_id: response.intelligence_subject_id,
        });
        return { kind: response.replayed === true ? 'replayed' : 'ingested' };
      } catch (err) {
        if (err instanceof IntelligenceRejectedError) return { kind: 'rejected', code: `TI_${err.status}_${err.code}` };
        if (err instanceof IntelligenceUnavailableError) {
          if (attempt >= maxAttempts) return { kind: 'failed', code: `TI_UNAVAILABLE${err.status !== null ? `_${err.status}` : ''}` };
          await this.sleep(Math.min(MAX_BACKOFF_MS, base * 2 ** (attempt - 1)));
          continue;
        }
        return { kind: 'failed', code: 'UNEXPECTED' };
      }
    }
  }

  /** Run `fn` over `items` with at most `n` in flight; results in input order. */
  private async pool<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }
}
