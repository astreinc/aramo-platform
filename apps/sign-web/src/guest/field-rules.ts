import type { SignField } from './sign-api.js';

// M-A6 §2 — the Name and Checkbox rules on the signer page. They mirror the
// server's completion rules (EsignService.completeSigner), so Finish is offered
// only when the server will accept it; the server stays the authority.

// A field restored from an earlier visit without its value.
export const FILLED_MARK = '✓';

export const isBox = (f: Pick<SignField, 'field_type'>): boolean => f.field_type === 'CHECKBOX' || f.field_type === 'ACKNOWLEDGEMENT';

// A SIGNER_NAME the server fills from the signer profile: shown read-only and
// never sent by this page. A legacy name field (name_mode null) is typed.
export const isServerName = (f: Pick<SignField, 'field_type' | 'name_mode' | 'server_filled'>): boolean =>
  f.field_type === 'SIGNER_NAME' && (f.server_filled === true || f.name_mode === 'SIGNER_PROFILE');

export const isChecked = (v: string | undefined): boolean => v === 'true' || v === FILLED_MARK;

const groupOf = (f: Pick<SignField, 'field_type' | 'group_key'>): string | null =>
  f.field_type === 'CHECKBOX' && typeof f.group_key === 'string' && f.group_key.length > 0 ? f.group_key : null;

// The other boxes a SELECT_ONE group unchecks when `f` is checked.
export function selectOneSiblings(fields: readonly SignField[], f: SignField): SignField[] {
  const g = groupOf(f);
  if (g === null || f.group_rule !== 'SELECT_ONE') return [];
  return fields.filter((o) => o.field_id !== f.field_id && groupOf(o) === g);
}

export interface Requirement {
  readonly key: string;
  readonly done: boolean;
  readonly message: string;
}

// Each thing the signer must do before Finish: a required field to fill, a
// required box to check, or a group rule to satisfy. A group is required when
// any of its boxes is; SELECT_ONE never allows more than one checked box.
export function requirements(fields: readonly SignField[], filled: Readonly<Record<string, string>>): Requirement[] {
  const out: Requirement[] = [];
  const groups = new Map<string, SignField[]>();
  for (const f of fields) {
    if (isServerName(f)) continue;
    const g = groupOf(f);
    if (g !== null) {
      groups.set(g, [...(groups.get(g) ?? []), f]);
      continue;
    }
    if (!f.required) continue;
    if (isBox(f)) out.push({ key: f.field_id, done: isChecked(filled[f.field_id]), message: `Check the required box${f.label ? ` “${f.label}”` : ''}.` });
    else out.push({ key: f.field_id, done: filled[f.field_id] !== undefined, message: 'Some required fields still need your input.' });
  }
  for (const [g, boxes] of groups) {
    const checked = boxes.filter((b) => isChecked(filled[b.field_id])).length;
    const one = boxes[0]?.group_rule === 'SELECT_ONE';
    const required = boxes.some((b) => b.required);
    if (one && checked > 1) {
      out.push({ key: `group:${g}`, done: false, message: 'Choose only one option in each “select one” group.' });
      continue;
    }
    if (!required) continue;
    const min = one ? 1 : Math.max(1, ...boxes.map((b) => b.min_selected ?? 1));
    out.push({
      key: `group:${g}`,
      done: checked >= min,
      message: one ? 'Choose one option in each required group.' : `Check at least ${min} option${min === 1 ? '' : 's'} in each required group.`,
    });
  }
  return out;
}

// The first unmet requirement's message, or null when Finish may proceed.
export function completionProblem(fields: readonly SignField[], filled: Readonly<Record<string, string>>): string | null {
  return requirements(fields, filled).find((r) => !r.done)?.message ?? null;
}

// The server's 409 SIGNATURE_FIELD_INCOMPLETE reasons, in plain language.
export function incompleteMessage(reason: string | undefined): string {
  if (reason === 'checkbox_required_unchecked') return 'A required box still needs to be checked.';
  if (reason === 'checkbox_group_select_one') return 'Choose exactly one option in each “select one” group.';
  if (reason === 'checkbox_group_min_selected') return 'Check enough options in each required group.';
  return 'Some required fields still need your input.';
}
