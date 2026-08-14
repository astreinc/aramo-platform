// T9-B1 — FE mirror of libs/reporting FillPerformanceReportView (the FE never
// imports the BE DTO across the domain seam; it hand-mirrors the shape).
export interface FillPerformanceReport {
  period: { from: string; to: string };
  openings: number;
  filled_openings: number;
  fill_rate: number | null;
  fully_filled_requisitions: number;
  time_to_fill: { count: number; average_days: number | null };
}
