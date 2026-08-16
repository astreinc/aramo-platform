// T9-B4 — FE mirror of libs/reporting MarginReportView. Aggregate-only; the
// group field is `group_margin_percent` (NOT the row-level `margin_percent`
// that the global D5 mask strips) per the T9-B4 field-masking amendment.
export interface MarginGroup {
  currency: string;
  rate_period: string;
  assignment_count: number;
  group_margin_percent: string | null;
}

export interface MarginReport {
  eligible_count: number;
  commercialized_count: number;
  missing_commercial_count: number;
  coverage: 'forward_materialized';
  groups: MarginGroup[];
}
