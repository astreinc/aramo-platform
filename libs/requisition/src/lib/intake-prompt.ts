import type {
  IntakeExtractedFields,
  IntakeSkill,
} from './dto/intake-generation.dto.js';

// New Requisition AI intake — the BOUNDED, task-scoped prompt (Lead ruling
// Tab 1). The input is the recruiter's own intake text (a pasted client
// email OR a few hiring-manager lines). The model EXTRACTS stated
// requisition facts + DRAFTS a role description + required / nice-to-have
// requirement skills. It is NOT a general LLM passthrough: a fixed system
// message constrains it to drafting requisition TEXT only.
//
// R10: the prompt describes a ROLE and its stated REQUIREMENTS — it must
// NEVER instruct the model to assess, judge, or order any person. The
// extracted skills are req requirements, not a match profile.
//
// PII redaction (D6) + no-raw-prompt-logging (D7) are applied inside
// AiDraftService — a client email's contact address/phone are scrubbed
// before the provider call (we need the role facts, not the PII).

// Size cap on the intake text (chars). Keeps the call bounded; over-length
// → VALIDATION_ERROR at the service boundary (no truncated LLM call).
export const INTAKE_TEXT_MAX_CHARS = 8000;

const INTAKE_SYSTEM_MESSAGE = [
  'You are an expert technical recruiter assistant. You are given a single',
  "block of intake text — either a client's email describing a job opening or",
  'a few short notes from a hiring manager. Your job is to (1) EXTRACT the',
  'requisition facts the text STATES, and (2) DRAFT a clear, professional job',
  'description plus required and nice-to-have requirement skills for the role.',
  '',
  'Rules:',
  '- Only extract facts the text actually states. If a field is not stated,',
  '  omit it (do not guess a value).',
  '- You describe the ROLE and its stated REQUIREMENTS only. You must NEVER',
  '  assess, judge, compare, or pass any quality verdict on a person. The',
  '  skills you output are requirements the JOB needs — not a profile of a',
  '  person and not an ordering of people.',
  '- Do NOT invent compensation you were not given. If the text states a bill',
  '  rate or rate type, extract it verbatim as stated; otherwise omit it.',
  '',
  'Return ONLY a single JSON object, no prose around it, with this shape:',
  '{',
  '  "fields": {',
  '    "title": string|null,',
  '    "company_name": string|null,',
  '    "hiring_manager": string|null,',
  '    "job_type": string|null,            // contract | contract_to_hire | contract_to_perm | direct_perm',
  '    "seniority_level": string|null,      // junior | mid | senior | lead | principal',
  '    "role_family": string|null,',
  '    "openings": number|null,',
  '    "city": string|null,',
  '    "state": string|null,',
  '    "work_arrangement": string|null,     // onsite | hybrid | remote',
  '    "work_authorization": string|null,   // e.g. us_citizen | gc | h1b_ok | any (as stated)',
  '    "bill_rate": string|null,            // the stated amount only, e.g. "85"',
  '    "rate_type": string|null,            // C2C | W2 | 1099 | Any',
  '    "allow_subcontractors": boolean|null,',
  '    "duration_value": number|null,',
  '    "duration_unit": string|null,        // weeks | months',
  '    "start_date": string|null            // as stated, e.g. "within 3 weeks"',
  '  },',
  '  "jd_text": string,',
  '  "required_skills": [{"name": string}],',
  '  "nice_to_have_skills": [{"name": string}]',
  '}',
].join('\n');

export function buildIntakePrompt(intakeText: string): {
  prompt: string;
  system_message: string;
} {
  const prompt = ['Intake text:', intakeText].join('\n');
  return { prompt, system_message: INTAKE_SYSTEM_MESSAGE };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function skillList(v: unknown): IntakeSkill[] {
  if (!Array.isArray(v)) return [];
  const out: IntakeSkill[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.trim() !== '') {
      out.push({ name: item.trim() });
    } else if (
      item !== null &&
      typeof item === 'object' &&
      typeof (item as { name?: unknown }).name === 'string' &&
      (item as { name: string }).name.trim() !== ''
    ) {
      out.push({ name: (item as { name: string }).name.trim() });
    }
  }
  return out;
}

// Parse the LLM completion into the typed intake draft. Tolerant: extracts
// the first JSON object; on any failure falls back to treating the whole
// completion as the JD prose with empty fields/skills — the recruiter
// reviews + edits before committing either way (R8/R12). NOTE: a parse
// fallback is NOT a fabricated draft — the model DID respond; only a missing
// PROVIDER (handled upstream as AI_PROVIDER_UNAVAILABLE) is the HALT case.
export function parseIntakeCompletion(completion: string): {
  fields: IntakeExtractedFields;
  jd_text: string;
  required_skills: IntakeSkill[];
  nice_to_have_skills: IntakeSkill[];
} {
  let parsed: Record<string, unknown> | null = null;
  try {
    const start = completion.indexOf('{');
    const end = completion.lastIndexOf('}');
    if (start !== -1 && end > start) {
      parsed = JSON.parse(completion.slice(start, end + 1)) as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    return {
      fields: {},
      jd_text: completion.trim(),
      required_skills: [],
      nice_to_have_skills: [],
    };
  }
  const f = (parsed['fields'] ?? {}) as Record<string, unknown>;
  const fields: IntakeExtractedFields = {};
  const title = asString(f['title']);
  if (title !== undefined) fields.title = title;
  const company_name = asString(f['company_name']);
  if (company_name !== undefined) fields.company_name = company_name;
  const hiring_manager = asString(f['hiring_manager']);
  if (hiring_manager !== undefined) fields.hiring_manager = hiring_manager;
  const job_type = asString(f['job_type']);
  if (job_type !== undefined) fields.job_type = job_type;
  const seniority_level = asString(f['seniority_level']);
  if (seniority_level !== undefined) fields.seniority_level = seniority_level;
  const role_family = asString(f['role_family']);
  if (role_family !== undefined) fields.role_family = role_family;
  const openings = asNumber(f['openings']);
  if (openings !== undefined) fields.openings = openings;
  const city = asString(f['city']);
  if (city !== undefined) fields.city = city;
  const state = asString(f['state']);
  if (state !== undefined) fields.state = state;
  const work_arrangement = asString(f['work_arrangement']);
  if (work_arrangement !== undefined) fields.work_arrangement = work_arrangement;
  const work_authorization = asString(f['work_authorization']);
  if (work_authorization !== undefined) fields.work_authorization = work_authorization;
  const bill_rate = asString(f['bill_rate']);
  if (bill_rate !== undefined) fields.bill_rate = bill_rate;
  const rate_type = asString(f['rate_type']);
  if (rate_type !== undefined) fields.rate_type = rate_type;
  const allow_subcontractors = asBoolean(f['allow_subcontractors']);
  if (allow_subcontractors !== undefined) fields.allow_subcontractors = allow_subcontractors;
  const duration_value = asNumber(f['duration_value']);
  if (duration_value !== undefined) fields.duration_value = duration_value;
  const duration_unit = asString(f['duration_unit']);
  if (duration_unit !== undefined) fields.duration_unit = duration_unit;
  const start_date = asString(f['start_date']);
  if (start_date !== undefined) fields.start_date = start_date;

  const jd_text =
    typeof parsed['jd_text'] === 'string' ? (parsed['jd_text'] as string) : completion.trim();
  return {
    fields,
    jd_text,
    required_skills: skillList(parsed['required_skills']),
    nice_to_have_skills: skillList(parsed['nice_to_have_skills']),
  };
}
