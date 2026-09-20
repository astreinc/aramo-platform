// TALENT-INTEL-1 TI-1G §3 — the recruiter-facing work-authorization read model:
// the DETERMINISTIC current state + the append-only assertion history. The scalar
// TalentRecord.work_authorization remains the coarse operational projection; this
// surface exposes the governed evidence (with its temporal + decomposed detail)
// without the scalar ever becoming a competing authority.

export interface WorkAuthorizationAssertionView {
  readonly work_authorization_status: string;
  readonly authorized_to_work_in: readonly string[];
  readonly visa_type: string | null;
  readonly requires_sponsorship: boolean;
  // ISO-8601: asserted_at is a timestamp; effective_*/expires_at are date-only
  // (null when the recruiter did not state them — never invented).
  readonly asserted_at: string;
  readonly effective_from: string | null;
  readonly effective_to: string | null;
  readonly expires_at: string | null;
}

export interface WorkAuthorizationStateView {
  readonly talent_id: string;
  readonly current: WorkAuthorizationAssertionView | null;
  readonly history: readonly WorkAuthorizationAssertionView[];
}

const dateOnly = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);

// Structural row shape (the fields this view reads) — kept inline so the DTO does
// not depend on the cross-lib TalentWorkAuthorizationRow re-export; the controller
// passes the service's rows, which are structurally compatible.
export interface WorkAuthorizationAssertionRow {
  readonly work_authorization_status: string;
  readonly authorized_to_work_in: readonly string[];
  readonly visa_type: string | null;
  readonly requires_sponsorship: boolean;
  readonly asserted_at: Date;
  readonly effective_from: Date | null;
  readonly effective_to: Date | null;
  readonly expires_at: Date | null;
}

export function toWorkAuthorizationAssertionView(
  row: WorkAuthorizationAssertionRow,
): WorkAuthorizationAssertionView {
  return {
    work_authorization_status: row.work_authorization_status,
    authorized_to_work_in: row.authorized_to_work_in,
    visa_type: row.visa_type,
    requires_sponsorship: row.requires_sponsorship,
    asserted_at: row.asserted_at.toISOString(),
    effective_from: dateOnly(row.effective_from),
    effective_to: dateOnly(row.effective_to),
    expires_at: dateOnly(row.expires_at),
  };
}
