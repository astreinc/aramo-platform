// Track 7 / T7-P5 — FE mirror of the T7-P4 GuaranteeExposureReportView (libs/reporting
// dto/report.view.ts). Summary-only: money is per-currency STRINGS (never summed across
// currencies, never FX-converted); counts may be cross-currency. remedy_obligation totals are
// OBLIGATIONS (owed), not payments. period.from/to are absolute instants.

export interface GuaranteeExposureCurrencyBucket {
  readonly currency: string;
  readonly total: string;
  readonly active: string;
  readonly satisfied: string;
  readonly fell_off: string;
  readonly at_risk: string;
}

export interface GuaranteeExposureObligationBucket {
  readonly currency: string;
  readonly refund_total: string;
  readonly prorated_credit_total: string;
}

export interface GuaranteeExposureReport {
  readonly period: { readonly from: string; readonly to: string };
  readonly cohort_count: number;
  readonly exposure_by_currency: readonly GuaranteeExposureCurrencyBucket[];
  readonly states: {
    readonly active: number;
    readonly satisfied: number;
    readonly fell_off: number;
    readonly remedy_due: {
      readonly replacement: number;
      readonly refund: number;
      readonly prorated_credit: number;
    };
    readonly remedy_completed: number;
  };
  readonly remedy_obligation_by_currency: readonly GuaranteeExposureObligationBucket[];
  readonly falloff_rate: number;
}
