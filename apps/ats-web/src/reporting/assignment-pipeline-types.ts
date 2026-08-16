// T9-B3 — FE mirror of libs/reporting AssignmentPipelineReportView.
export interface AssignmentPipelineStateCount {
  state: string;
  count: number;
}

export interface AssignmentPipelineReport {
  total_live: number;
  by_state: AssignmentPipelineStateCount[];
  start_date: {
    overdue: number;
    today: number;
    next_7_days: number;
    later: number;
    unspecified: number;
    timezone_basis: 'UTC';
  };
  contract_assignments: {
    active: number;
    ended: number;
    coverage: 'forward_materialized';
  };
}
