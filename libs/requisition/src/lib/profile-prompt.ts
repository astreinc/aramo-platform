import type { GoldenProfileContent } from '@aramo/job-domain';

import type { RequisitionView } from './dto/requisition.view.js';

// Job-Module LB-3 / ADR-0015 v1.2 G4 — the COMMERCIAL-NEVER-TO-LLM boundary.
//
// THE BINDING CONSTRAINT: the generation prompt is built from an ALLOWLIST
// of role-content fields — NEVER by passing the Requisition wholesale. The
// LLM sees role content (title, classification, seniority, work
// arrangement, location, duration); it NEVER sees the agency's economics
// or internal commentary: pay/bill rate, margin, markup, placement fee,
// salary, rate cards, target_margin_percent, markup_percent_target, the
// min/max rate ranges, or `notes`. Those fields are STRUCTURALLY excluded
// — extractRoleContent() reads ONLY the allowlisted keys, so a commercial
// or notes field added to the Requisition cannot leak into the prompt
// (proven by the G4 spec).

// The allowlist — the ONLY requisition fields that may enter the prompt.
export const ROLE_CONTENT_PROMPT_ALLOWLIST = [
  'title',
  'job_type',
  'labor_category',
  'role_family',
  'seniority_level',
  'work_arrangement',
  'work_authorization',
  'travel_percent',
  'relocation_offered',
  'duration_value',
  'duration_unit',
  'hours_per_week',
  'city',
  'state',
] as const;

export interface RoleContentForPrompt {
  title: string;
  job_type: string | null;
  labor_category: string | null;
  role_family: string | null;
  seniority_level: string | null;
  work_arrangement: string | null;
  work_authorization: string | null;
  travel_percent: number | null;
  relocation_offered: boolean;
  duration_value: number | null;
  duration_unit: string | null;
  hours_per_week: number | null;
  city: string | null;
  state: string | null;
}

// Build the allowlisted role-content object from a requisition view. Reads
// ONLY the allowlisted keys — commercial / financial / notes fields on the
// view are never touched here (the structural G4 guarantee).
export function extractRoleContent(view: RequisitionView): RoleContentForPrompt {
  return {
    title: view.title,
    job_type: view.job_type,
    labor_category: view.labor_category,
    role_family: view.role_family,
    seniority_level: view.seniority_level,
    work_arrangement: view.work_arrangement,
    work_authorization: view.work_authorization,
    travel_percent: view.travel_percent,
    relocation_offered: view.relocation_offered,
    duration_value: view.duration_value,
    duration_unit: view.duration_unit,
    hours_per_week: view.hours_per_week,
    city: view.city,
    state: view.state,
  };
}

const PROFILE_SYSTEM_MESSAGE = [
  'You are an expert technical recruiter assistant. From the recruiter brief',
  'and the structured role content, produce (1) a clear, professional job',
  'description and (2) a structured "golden profile" for talent matching.',
  'Return ONLY a single JSON object, no prose around it, with this shape:',
  '{',
  '  "jd_text": string,',
  '  "golden_profile": {',
  '    "role_family": string|null,',
  '    "seniority_level": string|null,',
  '    "required_skills": [{"name": string, "min_years": number|null}],',
  '    "preferred_skills": [{"name": string}],',
  '    "critical_skills": [{"name": string, "min_years": number|null}],',
  '    "experience": {"total_years": number|null, "domain": string|null, "industries": [string]},',
  '    "constraints": {"location": string|null, "work_mode": string|null, "rate": string|null, "work_authorization": string|null}',
  '  }',
  '}',
  'Do NOT invent compensation, pay, bill, margin, or fee figures — those are',
  'not provided and must not appear.',
].join('\n');

// Render the allowlisted role content as labelled lines (skips nulls).
function renderRoleContent(role: RoleContentForPrompt): string {
  const lines: string[] = [`Title: ${role.title}`];
  if (role.role_family) lines.push(`Role family: ${role.role_family}`);
  if (role.seniority_level) lines.push(`Seniority: ${role.seniority_level}`);
  if (role.job_type) lines.push(`Engagement type: ${role.job_type}`);
  if (role.labor_category) lines.push(`Labor category: ${role.labor_category}`);
  if (role.work_arrangement) lines.push(`Work arrangement: ${role.work_arrangement}`);
  if (role.work_authorization) lines.push(`Work authorization: ${role.work_authorization}`);
  if (role.travel_percent !== null) lines.push(`Travel: ${role.travel_percent}%`);
  lines.push(`Relocation offered: ${role.relocation_offered ? 'yes' : 'no'}`);
  if (role.duration_value !== null && role.duration_unit) {
    lines.push(`Duration: ${role.duration_value} ${role.duration_unit}`);
  }
  if (role.hours_per_week !== null) lines.push(`Hours/week: ${role.hours_per_week}`);
  if (role.city || role.state) {
    lines.push(`Location: ${[role.city, role.state].filter(Boolean).join(', ')}`);
  }
  return lines.join('\n');
}

export function buildProfilePrompt(args: {
  brief: string;
  role: RoleContentForPrompt;
}): { prompt: string; system_message: string } {
  const prompt = [
    'Recruiter brief:',
    args.brief,
    '',
    'Structured role content:',
    renderRoleContent(args.role),
  ].join('\n');
  return { prompt, system_message: PROFILE_SYSTEM_MESSAGE };
}

// Parse the LLM completion into the typed { jd_text, golden_profile }.
// Tolerant: extracts the first JSON object; on any failure falls back to
// treating the whole completion as the JD prose with an empty profile —
// the recruiter reviews + edits before confirm either way (G1).
export function parseProfileCompletion(
  completion: string,
  brief: string,
): { jd_text: string; golden_profile: GoldenProfileContent } {
  const empty: GoldenProfileContent = {
    jd_text: '',
    generated_by: 'ai_draft',
    required_skills: [],
    preferred_skills: [],
    critical_skills: [],
    experience: { industries: [] },
    constraints: {},
  };
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
    return { jd_text: completion.trim() || brief, golden_profile: { ...empty, jd_text: completion.trim() } };
  }
  const gp = (parsed['golden_profile'] ?? {}) as Record<string, unknown>;
  const jd_text = typeof parsed['jd_text'] === 'string' ? (parsed['jd_text'] as string) : completion.trim();
  const exp = (gp['experience'] ?? {}) as Record<string, unknown>;
  const con = (gp['constraints'] ?? {}) as Record<string, unknown>;
  const golden_profile: GoldenProfileContent = {
    role_family: (gp['role_family'] as string | undefined) ?? undefined,
    seniority_level: (gp['seniority_level'] as string | undefined) ?? undefined,
    jd_text,
    generated_by: 'ai_draft',
    required_skills: Array.isArray(gp['required_skills']) ? (gp['required_skills'] as GoldenProfileContent['required_skills']) : [],
    preferred_skills: Array.isArray(gp['preferred_skills']) ? (gp['preferred_skills'] as GoldenProfileContent['preferred_skills']) : [],
    critical_skills: Array.isArray(gp['critical_skills']) ? (gp['critical_skills'] as GoldenProfileContent['critical_skills']) : [],
    experience: {
      total_years: exp['total_years'] as number | undefined,
      domain: exp['domain'] as string | undefined,
      industries: Array.isArray(exp['industries']) ? (exp['industries'] as string[]) : [],
    },
    constraints: {
      location: con['location'] as string | undefined,
      work_mode: con['work_mode'] as string | undefined,
      rate: con['rate'] as string | undefined,
      work_authorization: con['work_authorization'] as string | undefined,
    },
  };
  return { jd_text, golden_profile };
}
