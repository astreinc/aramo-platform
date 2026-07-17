import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import {
  ClusterPurgeService,
  IdentityIndexRepository,
} from '@aramo/identity-index';
import { PlatformTrustRepository } from '@aramo/platform-trust';
import { TalentTrustService } from '@aramo/talent-trust';

import { DormantNoticeService } from './dormant-notice.service.js';
import {
  DORMANT_LINK_MINTING_ENABLED,
  IDENTITY_INDEX_LIFECYCLE_BATCH_SIZE,
  ORPHAN_GRACE_DAYS,
} from './identity-lifecycle-sweep.queue.constants.js';

// TR-2b B2a (Directive §PR-1.3) — the daily identity-index lifecycle sweep.
// Two duties over the PII-free cluster index, both batch-bounded per tick:
//
//   (a) LIVE — orphan purge: a cluster that fails the R4 liveness rule (zero
//       live PERSON_CLUSTER refs resolving to a live TalentRecord) AND is older
//       than ORPHAN_GRACE_DAYS → purgeCluster. This is the backstop for orphans
//       that arise WITHOUT the erasure path (which purges immediately, B2b).
//   (b) DARK — dormant detection: a cluster whose live refs span ≥2 distinct
//       tenants is dormant-eligible. REPORT-ONLY: minting a DormantLink is gated
//       behind DORMANT_LINK_MINTING_ENABLED=false (the D14 invariant is
//       structural — no minting without P4 notice capability). The gated branch
//       is exercised only by the flag in tests.
//
// The R4 liveness chain is the portal-resolver traversal (findClusterHolders →
// resolveSubjectRef husk→survivor → listSubjectRefs → ATS_TALENT_RECORD ref).
// A cluster with 0 live tenants is an orphan; ≥2 is dormant; exactly 1 is normal.
//
// No watermark column (the I14 wall forbids adding one without HALT). Coverage:
// the daily tick reaps a bounded keyset slice from the head; the CLI escape
// hatch keyset-loops the whole estate (each query LIMIT-bounded). purgeCluster
// removes orphans; the cursor advances by id past live/dormant clusters — the
// full pass covers every cluster exactly once. Per-item try/catch never aborts
// the batch.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface LifecycleSweepResult {
  scanned: number;
  orphans_purged: number;
  dormant_detected: number;
  dormant_minted: number;
  /** Portal P4a — links delivered a notice + transitioned PENDING_NOTICE→NOTICED. */
  dormant_noticed: number;
  failed: number;
  last_id: string | null;
}

export interface DrainBatchArgs {
  batchSize?: number;
  afterId?: string;
  now?: Date;
  /** Report-only: log would-purge, do not call purgeCluster. Default false. */
  dryRun?: boolean;
  /** Override the mint gate for the DARK duty (tests only). Default = the const. */
  mintingEnabled?: boolean;
}

@Injectable()
export class IdentityLifecycleSweepService {
  constructor(
    private readonly identityIndex: IdentityIndexRepository,
    private readonly trust: TalentTrustService,
    private readonly purge: ClusterPurgeService,
    private readonly platformTrust: PlatformTrustRepository,
    private readonly dormantNotice: DormantNoticeService,
    @Inject('IdentityLifecycleSweepServiceLogger')
    private readonly logger: LoggerService,
  ) {}

  /**
   * The R4 liveness rule as a set of distinct tenants holding a LIVE record for
   * the cluster. Empty = orphan; size ≥ 2 = dormant; size 1 = normal.
   */
  private async liveTenants(clusterId: string): Promise<Set<string>> {
    const holders = await this.trust.findClusterHolders(clusterId);
    const live = new Set<string>();
    const seen = new Set<string>();
    for (const holder of holders) {
      if (seen.has(holder.tenant_id)) continue;
      seen.add(holder.tenant_id);
      const survivor = await this.trust.resolveSubjectRef({
        tenant_id: holder.tenant_id,
        ref_type: 'PERSON_CLUSTER',
        ref_id: clusterId,
      });
      if (survivor === null) continue;
      const refs = await this.trust.listSubjectRefs(holder.tenant_id, survivor.id);
      if (refs.some((r) => r.ref_type === 'ATS_TALENT_RECORD')) {
        live.add(holder.tenant_id);
      }
    }
    return live;
  }

  async drainBatch(args: DrainBatchArgs = {}): Promise<LifecycleSweepResult> {
    const batchSize = args.batchSize ?? IDENTITY_INDEX_LIFECYCLE_BATCH_SIZE;
    const now = args.now ?? new Date();
    const dryRun = args.dryRun ?? false;
    const mintingEnabled = args.mintingEnabled ?? DORMANT_LINK_MINTING_ENABLED;
    const graceCutoff = new Date(now.getTime() - ORPHAN_GRACE_DAYS * MS_PER_DAY);

    const clusters = await this.identityIndex.listClustersForSweep({
      batchSize,
      afterId: args.afterId,
    });
    const result: LifecycleSweepResult = {
      scanned: 0,
      orphans_purged: 0,
      dormant_detected: 0,
      dormant_minted: 0,
      dormant_noticed: 0,
      failed: 0,
      last_id: null,
    };

    for (const cluster of clusters) {
      result.scanned += 1;
      result.last_id = cluster.id;
      try {
        const live = await this.liveTenants(cluster.id);
        if (live.size === 0) {
          // Duty (a) — orphan. Purge only once past the grace window.
          if (cluster.created_at < graceCutoff) {
            if (dryRun) {
              this.logger.log({
                event: 'orphan_would_purge',
                cluster_id: cluster.id,
                created_at: cluster.created_at.toISOString(),
              });
            } else {
              await this.purge.purgeCluster(cluster.id, 'identity_index_lifecycle');
            }
            result.orphans_purged += 1;
          }
          // within grace → untouched
        } else if (live.size >= 2) {
          // Duty (b) — dormant. Report-only; mint is P4-gated.
          result.dormant_detected += 1;
          this.logger.log({
            event: 'dormant_cluster_detected',
            cluster_id: cluster.id,
            tenant_span: live.size,
            minting_enabled: mintingEnabled,
          });
          if (mintingEnabled) {
            const link = await this.platformTrust.mintDormantLink({
              cluster_id: cluster.id,
              detected_at: now,
            });
            result.dormant_minted += 1;
            // P4a: a freshly-minted (PENDING_NOTICE) link gets the full lawful
            // path — deliver → record → NOTICED. A re-observed link already past
            // PENDING_NOTICE is left alone (idempotent; no re-delivery).
            if (link.status === 'PENDING_NOTICE') {
              const delivered = await this.dormantNotice.deliverForCluster({
                dormantLinkId: link.id,
                clusterId: cluster.id,
                now,
              });
              if (delivered.delivered) result.dormant_noticed += 1;
            }
          }
        }
        // live.size === 1 → normal, skip
      } catch (err) {
        result.failed += 1;
        this.logger.warn({
          event: 'lifecycle_sweep_cluster_failed',
          cluster_id: cluster.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  // The scheduled seam (the processor calls this; acceptance specs call it
  // directly). A single bounded batch from the head — the daily backstop reap.
  async tick(): Promise<LifecycleSweepResult> {
    const result = await this.drainBatch();
    this.logger.log({ event: 'identity_lifecycle_sweep_tick_completed', ...result });
    return result;
  }

  // The manual CLI escape hatch: keyset-loop the whole estate, batch-bounded per
  // query. dry-run DEFAULT for the purge duty (the caller opts into --execute).
  // The cursor advances by id, so purged (removed) and live/dormant (skipped)
  // clusters are all passed exactly once; a short final batch ends the loop.
  async runToCompletion(
    opts: { dryRun?: boolean; now?: Date } = {},
  ): Promise<LifecycleSweepResult> {
    const dryRun = opts.dryRun ?? true;
    const total: LifecycleSweepResult = {
      scanned: 0,
      orphans_purged: 0,
      dormant_detected: 0,
      dormant_minted: 0,
      dormant_noticed: 0,
      failed: 0,
      last_id: null,
    };
    let afterId: string | undefined;
    for (;;) {
      const batch = await this.drainBatch({
        afterId,
        dryRun,
        now: opts.now,
      });
      total.scanned += batch.scanned;
      total.orphans_purged += batch.orphans_purged;
      total.dormant_detected += batch.dormant_detected;
      total.dormant_minted += batch.dormant_minted;
      total.dormant_noticed += batch.dormant_noticed;
      total.failed += batch.failed;
      if (batch.last_id !== null) total.last_id = batch.last_id;
      // A short batch (fewer than the bound) means the keyset reached the end.
      if (batch.scanned < IDENTITY_INDEX_LIFECYCLE_BATCH_SIZE) break;
      afterId = batch.last_id ?? undefined;
    }
    return total;
  }
}
