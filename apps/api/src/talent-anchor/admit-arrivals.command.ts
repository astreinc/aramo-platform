import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadIdentityAdmissionPolicy } from '@aramo/common';

import { AdmitArrivalsModule } from './admit-arrivals.module.js';
import { AdmitArrivalsService } from './admit-arrivals.service.js';

// TR-2b B2b (Directive §PR-2.2, R7) — the `admit-arrivals` backfill CLI, on the
// erase-talent CLI conventions. NO HTTP surface. It reads L1 arrivals
// (sourced_talent.SourcedTalent.normalized_email), fingerprints via the standing
// @aramo/common util, and admits the cross-tenant cluster KEY into the PII-free
// index via findOrCreateClusterByFingerprint('email').
//
// SCOPE — Directive §PR-2.2 ruled OPTION A: CLUSTER-KEY ADMISSION ONLY. The
// forward "arrival stamp + PERSON_CLUSTER ref" writes are per-subject artifacts of
// the ingestion (RawPayloadReference) + talent_trust subject path; an L1
// SourcedTalent arrival has neither, so those forward writers cannot be reused for
// a bare email without a refactor. Option C (synthesize RawPayloadReference rows)
// was REJECTED — it would corrupt ingestion provenance; Option B (generalize
// canonicalize to accept email+tenant) is a forward-writer refactor owned by the
// future L1-writer design (ADR-0019). So the CLI admits the cluster key and stops.
//
// L1 has no writer yet (D15 — the mechanism precedes the history): against the
// empty table the CLI reports 0. Idempotency is by construction.
//
// Refuses (fail-loud) unless ARAMO_IDENTITY_ADMISSION_POLICY=ALL_ARRIVALS
// (loadIdentityAdmissionPolicy throws if unset). DRY-RUN IS THE DEFAULT; the live
// run requires `--execute` AND re-typing the confirmation token.
//
// Usage (after build):
//   node dist/apps/api/src/talent-anchor/admit-arrivals.command.js
//   node dist/apps/api/src/talent-anchor/admit-arrivals.command.js --execute ALL_ARRIVALS

const CONFIRM_TOKEN = 'ALL_ARRIVALS';

async function main(): Promise<void> {
  const logger = new Logger('AdmitArrivals');
  const execFlag = process.argv[2];
  const confirm = process.argv[3];
  const dryRun = execFlag !== '--execute';

  // Fail-loud policy gate. loadIdentityAdmissionPolicy throws (500) if the env is
  // unset; a set-but-wrong policy is a named refusal.
  const policy = loadIdentityAdmissionPolicy();
  if (policy !== 'ALL_ARRIVALS') {
    logger.error(
      `admit-arrivals REFUSED — ARAMO_IDENTITY_ADMISSION_POLICY=${policy}; this backfill requires ALL_ARRIVALS`,
    );
    process.exitCode = 1;
    return;
  }
  if (!dryRun && confirm !== CONFIRM_TOKEN) {
    logger.error(
      `--execute requires re-typing the confirmation token: admit-arrivals --execute ${CONFIRM_TOKEN}`,
    );
    process.exitCode = 1;
    return;
  }

  const ctx = await NestFactory.createApplicationContext(AdmitArrivalsModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const result = await ctx.get(AdmitArrivalsService).run({ dryRun });

    // Structured audit log — per-tenant/per-channel admission counts.
    for (const c of result.channels) {
      logger.log({ event: 'admit_arrivals_channel', mode: result.mode, ...c });
    }
    logger.log(
      `admit-arrivals complete (${dryRun ? 'DRY-RUN' : 'EXECUTE'}): scanned=${result.scanned}, ` +
        `${dryRun ? 'would-admit' : 'admitted'}(new clusters)=${result.admitted}, ` +
        `already-present=${result.already_present}`,
    );
    if (dryRun) {
      logger.log(
        `DRY-RUN — no clusters were admitted. Re-run with --execute ${CONFIRM_TOKEN} to admit.`,
      );
    }
  } finally {
    await ctx.close();
  }
}

void main();
