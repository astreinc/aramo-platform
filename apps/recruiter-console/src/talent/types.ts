// Hand-mirrored from libs/talent-record/src/lib/dto/talent-record.view.ts.
// Source-annotated so a future BE shape change is caught by the failing
// build (the missing field) — not by silent drift at runtime. R2 hand-
// mirrors instead of importing @aramo/talent-record (a forbidden domain
// edge from apps/recruiter-console). The DTO is a flat field list (no
// enum / matrix logic) so the R1 structural-deep-equal drift-spec
// pattern is not applied here (rule of three — that pattern is for
// mirrored logic, not flat fields).

export interface TalentRecordView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly first_name: string;
  readonly last_name: string;
  readonly email1: string | null;
  readonly email2: string | null;
  readonly phone_home: string | null;
  readonly phone_cell: string | null;
  readonly phone_work: string | null;
  readonly address: string | null;
  readonly address2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly source: string | null;
  readonly key_skills: string | null;
  readonly current_employer: string | null;
  readonly current_pay: string | null;
  readonly desired_pay: string | null;
  readonly date_available: string | null;
  readonly can_relocate: boolean;
  readonly is_hot: boolean;
  readonly notes: string | null;
  readonly web_site: string | null;
  readonly best_time_to_call: string | null;
  readonly owner_id: string | null;
  readonly entered_by_id: string | null;
  readonly core_talent_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TalentRecordListResponse {
  readonly items: readonly TalentRecordView[];
}
