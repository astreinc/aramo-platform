// T9-B2 — FE mirror of the reporting FallthroughReportView (the FE never
// imports the BE DTO across the domain seam; it hand-mirrors the shape).
export interface FallthroughReasonRow {
  reason_code: string | null;
  reason_label: string;
  count: number;
  rate: number;
}

export interface FallthroughReport {
  period: { from: string; to: string };
  accepted_attempts: number;
  fallthrough_attempts: number;
  fallthrough_rate: number | null;
  reasons: FallthroughReasonRow[];
}
