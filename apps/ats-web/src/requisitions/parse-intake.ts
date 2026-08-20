// Deterministic (non-AI) requisition intake parser.
//
// For non-VMS clients the requirement arrives by email, already well-defined.
// The recruiter pastes it and "Import requisition" runs THIS function — a
// pure, synchronous, no-network heuristic parse that prefills the manual form
// for review. It calls no LLM, imports nothing from libs/ai-draft, and hits no
// endpoint (Directive REQ-DET-INTAKE-1; governed-by-exclusion from ADR-0015).
//
// Honesty floor (Directive §Decision 4):
//   - A closed-vocabulary field is populated ONLY when a stated token maps to a
//     locked-set member; otherwise it is left unset — never fabricated. (The
//     consuming applyDraft re-checks membership as a second guard.)
//   - The client's text is NEVER altered: the full paste is preserved verbatim
//     in jd_text so nothing is lost.
//
// The output shape is exactly what NewRequisitionView.applyDraft consumes.

export interface ParsedIntakeFields {
  title?: string;
  company_name?: string; // hint only — resolved to a real record by the recruiter
  hiring_manager?: string; // hint only
  job_type?: string;
  seniority_level?: string;
  role_family?: string;
  openings?: number;
  city?: string;
  state?: string;
  work_arrangement?: string;
  work_authorization?: string;
  bill_rate?: string;
  rate_type?: string;
  allow_subcontractors?: boolean;
  duration_value?: number;
  duration_unit?: string;
}

export interface ParsedIntake {
  fields: ParsedIntakeFields;
  jd_text: string;
  required_skills: { name: string }[];
  nice_to_have_skills: { name: string }[];
}

// ── Small helpers ───────────────────────────────────────────────────────────

function firstMatch(text: string, re: RegExp): string | undefined {
  const m = text.match(re);
  const g = m?.[1];
  return g === undefined ? undefined : g.trim();
}

function titleCaseIfLower(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Strip leading connective/filler phrases so "comfortable on AWS" → "AWS".
function cleanSkill(raw: string): string {
  return raw
    .trim()
    .replace(
      /^(?:comfortable\s+(?:on|with)\s+|experience\s+(?:with|in)\s+|proficient\s+(?:in|with)\s+|expert\s+(?:in|with)\s+|strong\s+|solid\s+|deep\s+|skilled\s+in\s+|knowledge\s+of\s+|hands[- ]on\s+(?:with\s+)?)/i,
      '',
    )
    .replace(/[.;:]+$/, '')
    .trim();
}

function splitSkills(clause: string): string[] {
  return clause
    .split(/\s*(?:[,/+&]|\band\b)\s*/i)
    .map(cleanSkill)
    .filter((s) => s.length > 0 && s.length <= 30 && s.split(/\s+/).length <= 4);
}

function uniq(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

// ── Field mappers (ordered so multi-word/more-specific wins) ─────────────────

function mapJobType(t: string): string | undefined {
  if (/\bcontract[\s-]*to[\s-]*hire\b|\bc2h\b/i.test(t)) return 'contract_to_hire';
  if (/\bcontract[\s-]*to[\s-]*perm\w*\b|\btemp[\s-]*to[\s-]*perm\w*\b/i.test(t)) return 'contract_to_perm';
  if (/\bdirect[\s-]*(?:hire|perm\w*)\b|\bpermanent\b|\bfull[\s-]*time\b|\bfte\b|\bperm\b/i.test(t)) return 'direct_perm';
  if (/\bcontract\w*\b|\bc2c\b|\bcorp[\s-]*to[\s-]*corp\b/i.test(t)) return 'contract';
  return undefined;
}

function mapRoleFamily(t: string): string | undefined {
  if (/\bfull[\s-]*stack\b/i.test(t)) return 'fullstack_engineer';
  if (/\bback[\s-]*end\b/i.test(t)) return 'backend_engineer';
  if (/\bfront[\s-]*end\b/i.test(t)) return 'frontend_engineer';
  if (/\bdev[\s-]*ops\b|\bsre\b|\bsite reliability\b/i.test(t)) return 'devops_sre';
  if (/\bdata engineer\w*\b/i.test(t)) return 'data_engineer';
  if (/\barchitect\b/i.test(t)) return 'architect';
  if (/\bqa\b|\bquality assurance\b|\btest engineer\b|\bsdet\b/i.test(t)) return 'qa_test_engineer';
  if (/\b(?:product|project|program) manager\b|\bpm\b/i.test(t)) return 'product_project_manager';
  if (/\bbusiness analyst\b|\bba\b/i.test(t)) return 'business_analyst';
  return undefined;
}

function mapSeniority(t: string): string | undefined {
  if (/\bprincipal\b/i.test(t)) return 'principal';
  if (/\blead\b/i.test(t)) return 'lead';
  if (/\bsenior\b|\bsr\.?\b/i.test(t)) return 'senior';
  if (/\bmid[\s-]*level\b|\bmid\b|\bintermediate\b/i.test(t)) return 'mid';
  if (/\bjunior\b|\bjr\.?\b|\bentry[\s-]*level\b/i.test(t)) return 'junior';
  return undefined;
}

function mapArrangement(t: string): string | undefined {
  if (/\bhybrid\b/i.test(t)) return 'hybrid';
  if (/\bremote\b|\bwork from home\b|\bwfh\b/i.test(t)) return 'remote';
  if (/\bon[\s-]*site\b|\bin[\s-]*office\b|\bon premises?\b/i.test(t)) return 'onsite';
  return undefined;
}

// Work authorization is a SINGLE select; a disjunction (e.g. "USC or GC") is
// not representable, so ambiguity → unset (honesty floor).
function mapWorkAuthorization(t: string): string | undefined {
  if (/\bno work auth\w*\b|\bany work auth\w*\b|\ball work auth\w*\b|\bwill sponsor\b|\bsponsorship (?:available|ok)\b/i.test(t)) {
    return 'any';
  }
  const usc = /\bus citizen\w*\b|\bu\.s\.\s*citizen\w*\b|\busc\b|\bcitizens? only\b/i.test(t);
  const gc = /\bgreen card\b|\bgc\b|\bpermanent resident\b|\blpr\b/i.test(t);
  const h1b = /\bh-?1b\b/i.test(t);
  const flags = [usc, gc, h1b].filter(Boolean).length;
  if (flags !== 1) return undefined; // none, or ambiguous multi
  if (usc) return 'us_citizen';
  if (gc) return 'gc';
  return 'h1b_ok';
}

function mapRateType(t: string): string | undefined {
  if (/\bc2c\b|\bcorp[\s-]*to[\s-]*corp\b/i.test(t)) return 'C2C';
  if (/\bw-?2\b/i.test(t)) return 'W2';
  if (/\b1099\b/i.test(t)) return '1099';
  return undefined;
}

// ── Skills ───────────────────────────────────────────────────────────────────

function extractNice(text: string): { nice: string[]; rest: string } {
  const m = text.match(
    /\b(?:nice[\s-]*to[\s-]*haves?|preferred|bonus(?:\s+skills?)?|pluses?|a plus)\b[:-]?\s*([^.\n]*)/i,
  );
  if (!m || m.index === undefined) return { nice: [], rest: text };
  const rest = text.slice(0, m.index) + text.slice(m.index + (m[0]?.length ?? 0));
  return { nice: splitSkills(m[1] ?? ''), rest };
}

function extractRequired(text: string): string[] {
  const m = text.match(
    /\b(?:must[\s-]*haves?|required skills?|requirements?|strong|proficient in|expert in|experience with|skills?)\b[:-]?\s*([^.\n]*)/i,
  );
  return m ? splitSkills(m[1] ?? '') : [];
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function parseRequisitionIntake(text: string): ParsedIntake {
  const jd_text = text.trim();
  const fields: ParsedIntakeFields = {};

  if (jd_text === '') {
    return { fields, jd_text, required_skills: [], nice_to_have_skills: [] };
  }

  // Title — a labelled line wins; else a "need a … <role-noun>" prose pattern.
  const labelledTitle = firstMatch(text, /^\s*(?:job title|title|role|position)\s*[:-]\s*(.+)$/im);
  const proseTitle = firstMatch(
    text,
    /\b(?:need|seeking|looking for|hiring|require|open(?:ing)?s?\s+for)\s+(?:an?\s+)?([A-Za-z][A-Za-z0-9 /+-]*?(?:engineer|developer|architect|manager|analyst|designer|scientist|administrator|consultant|specialist|programmer|lead|recruiter|accountant))\b/i,
  );
  const title = labelledTitle ?? proseTitle;
  if (title) fields.title = titleCaseIfLower(title);

  // Hints (never auto-selected).
  const company = firstMatch(text, /^\s*(?:client|company|account)\s*[:-]\s*(.+)$/im);
  if (company) fields.company_name = company;
  const hm = firstMatch(text, /^\s*(?:hiring manager|hm|contact|reports to)\s*[:-]\s*(.+)$/im);
  if (hm) fields.hiring_manager = hm;

  // Closed-vocabulary mappings (member-only).
  const jobType = mapJobType(text);
  if (jobType) fields.job_type = jobType;
  const roleFamily = mapRoleFamily(text);
  if (roleFamily) fields.role_family = roleFamily;
  const seniority = mapSeniority(title ?? text);
  if (seniority) fields.seniority_level = seniority;
  const arrangement = mapArrangement(text);
  if (arrangement) fields.work_arrangement = arrangement;
  const workAuth = mapWorkAuthorization(text);
  if (workAuth) fields.work_authorization = workAuth;
  const rateType = mapRateType(text);
  if (rateType) fields.rate_type = rateType;

  // Subcontractors — C2C / corp-to-corp / explicit sub language ⇒ allowed.
  if (/\bc2c\b|\bcorp[\s-]*to[\s-]*corp\b|\bsub[\s-]?contract\w*\b|\bsubs?\s+ok\b|\bindependent contractor\b/i.test(text)) {
    fields.allow_subcontractors = true;
  }

  // Location — "City, ST" wins; else "in <City>".
  const cityState = text.match(/\b([A-Z][a-zA-Z.-]+(?:\s[A-Z][a-zA-Z.-]+)*),\s*([A-Z]{2})\b/);
  if (cityState) {
    fields.city = cityState[1];
    fields.state = cityState[2];
  } else {
    const city = firstMatch(text, /\b(?:in|based in|located in|location[:-])\s+([A-Z][a-zA-Z.-]+)\b/);
    if (city) fields.city = city;
  }

  // Bill rate — hourly figure (contract client max).
  const rate = firstMatch(
    text,
    /\$\s?(\d{1,4}(?:\.\d+)?)\s*(?:\/|per\s+)?\s*(?:hr|hour|hourly)\b/i,
  ) ?? firstMatch(text, /\b(\d{2,4})\s*(?:\/\s*hr|per hour|hourly)\b/i);
  if (rate) fields.bill_rate = rate;

  // Openings — "<n> openings/positions/…".
  const openings = firstMatch(
    text,
    /\b(\d{1,3})\s*(?:openings?|positions?|seats?|roles?|hires?|headcount|reqs?)\b/i,
  );
  if (openings) {
    const n = Number(openings);
    if (n > 0) fields.openings = n;
  }

  // Duration — "<n> months|weeks".
  const dur = text.match(/\b(\d{1,3})\s*(?:\+\s*)?(month|months|mo|week|weeks|wk)s?\b/i);
  if (dur) {
    fields.duration_value = Number(dur[1]);
    fields.duration_unit = /^w/i.test(dur[2] ?? '') ? 'weeks' : 'months';
  }

  // Skills — nice-to-have first (removed from the text so it is not re-counted
  // as required), then required from the remainder.
  const { nice, rest } = extractNice(text);
  const required = uniq(extractRequired(rest)).filter(
    (r) => !nice.some((n) => n.toLowerCase() === r.toLowerCase()),
  );

  return {
    fields,
    jd_text,
    required_skills: required.map((name) => ({ name })),
    nice_to_have_skills: uniq(nice).map((name) => ({ name })),
  };
}
