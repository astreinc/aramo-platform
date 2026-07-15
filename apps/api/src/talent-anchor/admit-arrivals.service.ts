import { Injectable } from '@nestjs/common';
import { computeEmailFingerprint } from '@aramo/common';
import { IdentityIndexRepository } from '@aramo/identity-index';
import { SourcedTalentRepository } from '@aramo/sourced-talent';

// TR-2b B2b (Directive §PR-2.2, R7) — the admit-arrivals backfill core, extracted
// from the CLI so it is DI-testable. Reads L1 arrivals carrying a normalized_email
// and admits the cross-tenant cluster KEY into the PII-free index via
// findOrCreateClusterByFingerprint('email').
//
// SCOPE — Directive §PR-2.2 ruled OPTION A: CLUSTER-KEY ADMISSION ONLY (the
// forward arrival-stamp + PERSON_CLUSTER-ref writes are per-subject artifacts an
// L1 arrival has no target for; reusing them would need a forward-writer refactor,
// and inventing a writer is the forbidden parallel-writer). Idempotent by
// construction. phone deferred with the fingerprint kind vocab ('email' only).

const DEFAULT_BATCH_SIZE = 500;

export interface AdmitArrivalsChannelCount {
  tenant_id: string;
  source_channel: string;
  scanned: number;
  admitted: number; // clusters newly minted (or would-mint in dry-run)
  already_present: number; // fingerprint already had a cluster
}

export interface AdmitArrivalsResult {
  mode: 'dry-run' | 'execute';
  scanned: number;
  admitted: number;
  already_present: number;
  channels: AdmitArrivalsChannelCount[];
}

@Injectable()
export class AdmitArrivalsService {
  constructor(
    private readonly sourced: SourcedTalentRepository,
    private readonly index: IdentityIndexRepository,
  ) {}

  async run(opts: {
    dryRun: boolean;
    batchSize?: number;
  }): Promise<AdmitArrivalsResult> {
    const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    const counts = new Map<string, AdmitArrivalsChannelCount>();
    // Fingerprints already resolved THIS run — so a repeated email (the same
    // human arriving via 2+ channels/tenants) counts as ONE admission. This is
    // what gives dry-run vs execute PARITY: execute dedups because it persists the
    // cluster; dry-run persists nothing, so it must dedup in-memory to predict the
    // same admitted count.
    const seen = new Set<string>();
    let scanned = 0;
    let admitted = 0;
    let alreadyPresent = 0;
    let afterId: string | undefined;

    for (;;) {
      const batch = await this.sourced.listArrivalsWithEmail({ batchSize, afterId });
      if (batch.length === 0) break;
      for (const arrival of batch) {
        scanned += 1;
        const key = `${arrival.tenant_id} ${arrival.source_channel}`;
        const c = counts.get(key) ?? {
          tenant_id: arrival.tenant_id,
          source_channel: arrival.source_channel,
          scanned: 0,
          admitted: 0,
          already_present: 0,
        };
        c.scanned += 1;

        // The standing fingerprint util (HMAC over ARAMO_IDENTITY_PEPPER).
        const fingerprint = computeEmailFingerprint(arrival.normalized_email);
        let admittedNew = false;
        if (!seen.has(fingerprint)) {
          seen.add(fingerprint);
          const existing = await this.index.findClusterByFingerprint(fingerprint);
          if (existing === null) {
            admittedNew = true;
            if (!opts.dryRun) {
              // Cluster-key admission (idempotent): absent fingerprint mints ONE
              // cluster. Same primitive forward ingestion uses.
              await this.index.findOrCreateClusterByFingerprint(fingerprint, 'email');
            }
          }
        }
        if (admittedNew) {
          c.admitted += 1;
          admitted += 1;
        } else {
          c.already_present += 1;
          alreadyPresent += 1;
        }
        counts.set(key, c);
      }
      afterId = batch[batch.length - 1]?.id;
      if (batch.length < batchSize) break;
    }

    return {
      mode: opts.dryRun ? 'dry-run' : 'execute',
      scanned,
      admitted,
      already_present: alreadyPresent,
      channels: [...counts.values()],
    };
  }
}
