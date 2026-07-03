import { Injectable, Logger } from '@nestjs/common';
import { normalizeEmail, normalizePhone } from '@aramo/common';
import {
  TalentRecordRepository,
  type TalentRecordView,
} from '@aramo/talent-record';
import { TalentTrustService, type AnchorKind } from '@aramo/talent-trust';

// TR-2a-1 — the ats→cip anchor PRODUCER. Lives in apps/api (the composition
// root, above the I15 wall): it reads TalentRecord identifiers (ats) AND writes
// the trust ledger (cip). This is the ONLY place those two sides meet — the wall
// forbids talent_trust (cip) from importing talent-record (ats); the producer
// bridges them here, above the wall, so neither lib gains a forbidden edge.
//
// For each non-empty identifier on a TalentRecord (email1/email2, phone_home/
// cell/work) it normalizes deterministically (Decision 10 — no LLM) and records
// a within-tenant anchor via TalentTrustService.recordAnchor (idempotent). Two
// triggers converge here: the write-time interceptor (fresh writes) and the
// backfill (existing rows) — both idempotent, so a talent can be produced by
// both without duplicating anchors.

const CREATED_BY = 'apps/api:talent-anchor-producer';

// The keyset cursor the backfill pages by (created_at, id) — stable ordering.
// created_at is the view's ISO-8601 string (TalentRecordView.created_at).
export interface BackfillCursor {
  created_at: string;
  id: string;
}

@Injectable()
export class TalentAnchorProducerService {
  private readonly logger = new Logger(TalentAnchorProducerService.name);

  constructor(
    private readonly talentRecords: TalentRecordRepository,
    private readonly trust: TalentTrustService,
  ) {}

  // Record EMAIL/PHONE anchors for one TalentRecord view. Idempotent; returns
  // the number of NEW anchors written (0 when all already existed). The view is
  // the create/update response (identifiers present) or a backfill page row.
  async recordAnchorsForView(view: TalentRecordView): Promise<number> {
    const discovered: Array<{ kind: AnchorKind; raw: string; normalized: string }> = [];
    for (const raw of [view.email1, view.email2]) {
      if (raw !== null && raw.trim().length > 0) {
        const normalized = normalizeEmail(raw);
        if (normalized.length > 0) discovered.push({ kind: 'EMAIL', raw, normalized });
      }
    }
    for (const raw of [view.phone_home, view.phone_cell, view.phone_work]) {
      if (raw !== null && raw.trim().length > 0) {
        const normalized = normalizePhone(raw);
        if (normalized.length > 0) discovered.push({ kind: 'PHONE', raw, normalized });
      }
    }

    // De-dupe WITHIN the record (e.g. email1 === email2, or work === cell) by
    // (kind, normalized) so we don't issue redundant recordAnchor calls.
    const seen = new Set<string>();
    let written = 0;
    for (const c of discovered) {
      const key = `${c.kind}:${c.normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await this.trust.recordAnchor({
        tenant_id: view.tenant_id,
        talent_record_id: view.id,
        anchor_kind: c.kind,
        normalized_value: c.normalized,
        raw_source: c.raw,
        created_by: CREATED_BY,
      });
      if (result !== null) written += 1;
    }
    return written;
  }

  // Backfill all existing TalentRecords for a tenant (keyset-paged, idempotent).
  // Returns totals. Safe to re-run — recordAnchor no-ops on existing anchors.
  async backfillTenant(
    tenantId: string,
    batchSize = 200,
  ): Promise<{ records: number; anchorsWritten: number }> {
    let cursor: BackfillCursor | undefined;
    let records = 0;
    let anchorsWritten = 0;
    for (;;) {
      const page = await this.talentRecords.listByTenantKeyset({
        tenant_id: tenantId,
        limit: batchSize,
        ...(cursor ? { after: cursor } : {}),
      });
      if (page.length === 0) break;
      for (const view of page) {
        records += 1;
        anchorsWritten += await this.recordAnchorsForView(view);
      }
      const last = page[page.length - 1]!;
      cursor = { created_at: last.created_at, id: last.id };
      if (page.length < batchSize) break;
    }
    this.logger.log(
      `anchor backfill tenant=${tenantId}: ${records} records, ${anchorsWritten} anchors written`,
    );
    return { records, anchorsWritten };
  }
}
