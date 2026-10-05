// D-EMAIL-TPL-1 (ET-3) — closed, server-side merge-field renderer for reusable
// email templates. NOT a template language: there is NO Handlebars/Mustache/EJS
// and NO arbitrary code — only substitution of an explicit, closed allowlist of
// `{{group.field}}` tokens. Two guarantees:
//   1. save-time validation rejects ANY unknown token (a bad template never
//      persists), so no `{{…}}` can reach a recipient; and
//   2. render substitutes only allowlisted tokens from SERVER-resolved values;
//      an unresolved OPTIONAL value substitutes empty + a closed-vocabulary
//      `<field>_unavailable` warning (mirroring the code-owned default), never a
//      raw placeholder.
// V1 is plain-text only (D-2), so there is no HTML and no HTML-escaping surface.
// The allowlist is grounded in RequisitionContactContext; `recruiter.email` is
// intentionally absent — the context carries no authoritative recruiter email
// (directive §6: omit rather than guess).

export const EMAIL_TEMPLATE_TOKENS = [
  'talent.first_name',
  'requisition.title',
  'requisition.reference',
  'requisition.location',
  'requisition.engagement_type',
  'requisition.work_arrangement',
  'recruiter.display_name',
  'company.name',
  'role.summary_excerpt',
] as const;

export type EmailTemplateToken = (typeof EMAIL_TEMPLATE_TOKENS)[number];

// COMM-RECRUITER-W1 §4B-cat — the General Talent Contact closed binding catalog:
// a requisition-free SUBSET of the global allowlist. Only these three tokens may
// appear in a `talent_general_contact` template (no requisition.* / role.* etc.).
export const GENERAL_TALENT_CONTACT_TOKENS = [
  'talent.first_name',
  'recruiter.display_name',
  'company.name',
] as const;

// COMM-RECRUITER-W1 §4B-cat — per-category binding allowlist. Each category's set
// is a SUBSET of EMAIL_TEMPLATE_TOKENS; a category not present here allows NOTHING
// (fail-closed). This is the authority for category-specific token validation at
// template create/update — a global-but-wrong-category token is rejected, never
// rendered empty.
export const CATEGORY_TEMPLATE_TOKENS: Readonly<Record<string, readonly EmailTemplateToken[]>> = {
  requisition_initial_contact: EMAIL_TEMPLATE_TOKENS,
  talent_general_contact: GENERAL_TALENT_CONTACT_TOKENS,
};

const ALLOWED: ReadonlySet<string> = new Set(EMAIL_TEMPLATE_TOKENS);

// Tokens are `{{ group.field }}` — lowercase dotted keys only. No spaces inside
// the key, optional surrounding whitespace tolerated.
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export class TemplateValidationError extends Error {
  constructor(public readonly unknownTokens: readonly string[]) {
    super(`unknown merge token(s): ${unknownTokens.join(', ')}`);
    this.name = 'TemplateValidationError';
  }
}

/** Every `{{token}}` in `text` must be in the closed allowlist. Throws
 *  TemplateValidationError listing any unknown tokens. The save-time gate used by
 *  template create/update (ET-4) so a bad template can never persist. */
export function validateTemplateTokens(text: string): void {
  const unknown = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const tok = m[1];
    if (tok !== undefined && !ALLOWED.has(tok)) unknown.add(tok);
  }
  if (unknown.size > 0) throw new TemplateValidationError([...unknown]);
}

/** COMM-RECRUITER-W1 §4B-cat — category-specific closed-allowlist gate. Every
 *  `{{token}}` in `text` must be in that CATEGORY's allowlist (a subset of the
 *  global set); an unknown category allows nothing. Throws TemplateValidationError
 *  listing the disallowed tokens. This is the fail-closed gate at template
 *  create/update so a General Talent Contact template can never carry a
 *  requisition-only token. */
export function validateTemplateTokensForCategory(category: string, text: string): void {
  const allowed = CATEGORY_TEMPLATE_TOKENS[category];
  const allowedSet: ReadonlySet<string> = allowed === undefined ? new Set<string>() : new Set(allowed);
  const unknown = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const tok = m[1];
    if (tok !== undefined && !allowedSet.has(tok)) unknown.add(tok);
  }
  if (unknown.size > 0) throw new TemplateValidationError([...unknown]);
}

export interface RenderResult {
  readonly text: string;
  readonly warnings: readonly string[];
}

/** Substitute a validated template against SERVER-resolved allowlist values.
 *  `values` keys are allowlist tokens; a null/empty value → empty substitution +
 *  a `<field>_unavailable` warning. An unknown token reaching here (should have
 *  been rejected at save time) fails closed — never left as raw markup. */
export function renderTemplate(
  text: string,
  values: Readonly<Record<string, string | null | undefined>>,
): RenderResult {
  const warnings = new Set<string>();
  const out = text.replace(TOKEN_RE, (_full, token: string) => {
    if (!ALLOWED.has(token)) {
      // Defense in depth: save-time validation should have rejected this.
      throw new TemplateValidationError([token]);
    }
    const v = values[token];
    if (v === null || v === undefined || v.length === 0) {
      warnings.add(`${token.replace(/\./g, '_')}_unavailable`);
      return '';
    }
    return v;
  });
  return { text: out, warnings: [...warnings] };
}
