// Hand-mirrored from the Job-Module BE DTO (the enterprise / commercial
// field expansion). These are the closed vocabularies + the FE-side form
// state shape for the additive enterprise fields (Classification / Work
// arrangement / Duration & schedule / Source) + the gated financial-
// planning fields.
//
// All enterprise fields are OPTIONAL + UN-gated. The financial-planning
// fields are gated on 'requisition:view:financials' (mirrors the D5
// defensive-FE posture the compensation section uses — see
// compensation-visibility.ts). When the actor lacks that scope the whole
// financial section is hidden AND its keys are never threaded into the
// create/patch body.

// --- Closed vocabularies (native <select> dropdowns) ---

export const JOB_TYPE_VALUES = [
  'contract',
  'contract_to_hire',
  'contract_to_perm',
  'direct_perm',
] as const;
export type JobType = (typeof JOB_TYPE_VALUES)[number];

export const ROLE_FAMILY_VALUES = [
  'backend_engineer',
  'frontend_engineer',
  'fullstack_engineer',
  'devops_sre',
  'data_engineer',
  'architect',
  'qa_test_engineer',
  'product_project_manager',
  'business_analyst',
] as const;
export type RoleFamily = (typeof ROLE_FAMILY_VALUES)[number];

export const SENIORITY_LEVEL_VALUES = [
  'junior',
  'mid',
  'senior',
  'lead',
  'principal',
] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVEL_VALUES)[number];

export const HEADCOUNT_REASON_VALUES = ['new', 'replacement'] as const;
export type HeadcountReason = (typeof HEADCOUNT_REASON_VALUES)[number];

export const WORK_ARRANGEMENT_VALUES = ['onsite', 'hybrid', 'remote'] as const;
export type WorkArrangement = (typeof WORK_ARRANGEMENT_VALUES)[number];

export const WORK_AUTHORIZATION_VALUES = [
  'us_citizen',
  'gc',
  'h1b_ok',
  'any',
] as const;
export type WorkAuthorization = (typeof WORK_AUTHORIZATION_VALUES)[number];

export const DURATION_UNIT_VALUES = ['weeks', 'months'] as const;
export type DurationUnit = (typeof DURATION_UNIT_VALUES)[number];

export const SOURCE_SYSTEM_VALUES = [
  'manual',
  'fieldglass',
  'beeline',
  'oracle',
  'coupa',
  'email',
  'api',
] as const;
export type SourceSystem = (typeof SOURCE_SYSTEM_VALUES)[number];

// Friendly labels for the closed vocabularies. Keys are the wire values;
// labels are user-facing (Title Case). NOTE (lint-enforced): user-facing
// labels use the locked Aramo entity vocabulary — the person entity is
// "Talent" (never the generic ATS synonym).
export const ENTERPRISE_LABELS: Readonly<Record<string, string>> = {
  // job_type
  contract: 'Contract',
  contract_to_hire: 'Contract to hire',
  contract_to_perm: 'Contract to permanent',
  direct_perm: 'Direct permanent',
  // role_family
  backend_engineer: 'Backend engineer',
  frontend_engineer: 'Frontend engineer',
  fullstack_engineer: 'Fullstack engineer',
  devops_sre: 'DevOps / SRE',
  data_engineer: 'Data engineer',
  architect: 'Architect',
  qa_test_engineer: 'QA / test engineer',
  product_project_manager: 'Product / project manager',
  business_analyst: 'Business analyst',
  // seniority_level
  junior: 'Junior',
  mid: 'Mid',
  senior: 'Senior',
  lead: 'Lead',
  principal: 'Principal',
  // headcount_reason
  new: 'New',
  replacement: 'Replacement',
  // work_arrangement
  onsite: 'Onsite',
  hybrid: 'Hybrid',
  remote: 'Remote',
  // work_authorization
  us_citizen: 'US citizen',
  gc: 'Green card',
  h1b_ok: 'H-1B OK',
  any: 'Any',
  // duration_unit
  weeks: 'Weeks',
  months: 'Months',
  // source_system
  manual: 'Manual',
  fieldglass: 'Fieldglass',
  beeline: 'Beeline',
  oracle: 'Oracle',
  coupa: 'Coupa',
  email: 'Email',
  api: 'API',
};

export function enterpriseLabel(value: string): string {
  return ENTERPRISE_LABELS[value] ?? value;
}

// --- The gating scope for the financial-planning section ---
// Mirror of the compensation D5 floor: the section renders + threads its
// fields ONLY when the actor holds this scope.
export const FINANCIALS_VIEW_SCOPE = 'requisition:view:financials';

// --- Form state shapes (strings throughout — controlled-input idiom;
//     the consumer maps '' → omitted at submit) ---

export interface EnterpriseFormState {
  // Classification
  job_type: JobType | '';
  labor_category: string;
  role_family: RoleFamily | '';
  seniority_level: SeniorityLevel | '';
  headcount_reason: HeadcountReason | '';
  // Work arrangement
  work_arrangement: WorkArrangement | '';
  travel_percent: string;
  relocation_offered: boolean;
  work_authorization: WorkAuthorization | '';
  // Duration & schedule
  end_date: string;
  duration_value: string;
  duration_unit: DurationUnit | '';
  extension_possible: boolean;
  hours_per_week: string;
  // Source
  source_system: SourceSystem | '';
  external_req_id: string;
  imported_at: string;
}

export interface FinancialFormState {
  target_margin_percent: string;
  markup_percent_target: string;
  rate_card_id: string;
  min_bill_rate: string;
  max_bill_rate: string;
  min_pay_rate: string;
  max_pay_rate: string;
}

export function emptyEnterpriseFormState(): EnterpriseFormState {
  return {
    job_type: '',
    labor_category: '',
    role_family: '',
    seniority_level: '',
    headcount_reason: '',
    work_arrangement: '',
    travel_percent: '',
    relocation_offered: false,
    work_authorization: '',
    end_date: '',
    duration_value: '',
    duration_unit: '',
    extension_possible: false,
    hours_per_week: '',
    source_system: '',
    external_req_id: '',
    imported_at: '',
  };
}

export function emptyFinancialFormState(): FinancialFormState {
  return {
    target_margin_percent: '',
    markup_percent_target: '',
    rate_card_id: '',
    min_bill_rate: '',
    max_bill_rate: '',
    min_pay_rate: '',
    max_pay_rate: '',
  };
}

// The enterprise keys whose form value is a plain optional string/select
// (mapped '' → omitted). The two number fields (travel_percent,
// duration_value, hours_per_week) are sent as numbers; the two booleans
// (relocation_offered, extension_possible) are sent only when true.
export const ENTERPRISE_STRING_KEYS = [
  'job_type',
  'labor_category',
  'role_family',
  'seniority_level',
  'headcount_reason',
  'work_arrangement',
  'work_authorization',
  'end_date',
  'duration_unit',
  'source_system',
  'external_req_id',
  'imported_at',
] as const;

export const ENTERPRISE_NUMBER_KEYS = [
  'travel_percent',
  'duration_value',
  'hours_per_week',
] as const;

export const ENTERPRISE_BOOLEAN_KEYS = [
  'relocation_offered',
  'extension_possible',
] as const;

// Financial keys are all decimal-money/percent strings → omitted when ''.
export const FINANCIAL_STRING_KEYS = [
  'target_margin_percent',
  'markup_percent_target',
  'rate_card_id',
  'min_bill_rate',
  'max_bill_rate',
  'min_pay_rate',
  'max_pay_rate',
] as const;
