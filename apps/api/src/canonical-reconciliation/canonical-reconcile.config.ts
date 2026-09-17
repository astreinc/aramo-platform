import { Injectable } from '@nestjs/common';

// SKILL-TAX Canonical Reconciliation Activation — the mandatory activation
// watermark. The backstop only re-drives talents whose NEVER-reconciled evidence
// was created AT/AFTER this instant, so activation is new/changed-only and never
// a de-facto historical backfill. When unset/invalid the watermark is a
// far-future sentinel → the backstop is inert (nothing qualifies), never a sweep.
const FAR_FUTURE = new Date('9999-01-01T00:00:00.000Z');

@Injectable()
export class CanonicalReconcileConfig {
  get activationWatermark(): Date {
    const raw = process.env['SKILL_CANONICAL_RECONCILE_ACTIVATED_AT'];
    if (raw === undefined || raw.length === 0) return FAR_FUTURE;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? FAR_FUTURE : parsed;
  }
}
