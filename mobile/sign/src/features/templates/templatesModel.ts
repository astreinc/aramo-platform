// Templates screen model (M-A4 §6.4; handoff §2A "Templates"). Pure: it turns what the
// backend returned (the sender context's availability flags and the template library)
// into what the screen shows. Only returned metadata is shown (name, category, role and
// document counts, description); nothing is derived on the device, and an unavailable state
// always carries the server's reason.
import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { SenderTemplate, TemplateLibrary } from '../send/templates';

export const TEMPLATES_INTRO =
  'Approved by your organization. Pick one to start an envelope with its documents, roles and fields ready.';
export const TEMPLATES_FOOTNOTE =
  'Create and edit templates on the web, in Organization → Our templates.';

export const FEATURE_UNAVAILABLE = 'Templates aren’t available for your organization yet.';
export const NO_TEMPLATE_PERMISSION =
  'You don’t have access to templates. Ask an admin in your organization.';
export const NO_TEMPLATES = 'Your organization has no templates yet.';

// M-A12 W1-F — a Personal account has no organization: its own copy.
export const PERSONAL_TEMPLATES_INTRO =
  'Your templates. Pick one to start an envelope with its documents, roles and fields ready.';
export const PERSONAL_TEMPLATES_FOOTNOTE = 'Create and edit templates on the web.';
export const PERSONAL_NO_TEMPLATES = 'You have no templates yet.';
export const PERSONAL_NO_PERMISSION = 'Templates aren’t available on this account.';
/** The Personal Free prompt (M-A12 W1-F), with "View plans". */
export const PERSONAL_TEMPLATES_PROMPT = 'Sending the same thing over and over? Templates come with Standard.';

export type TemplateTab = 'mine' | 'shared';

function isPersonal(context: unknown): boolean {
  return rec(rec(context)['tenant'])['kind'] === 'PERSONAL';
}

/** The intro and footnote for the account kind. */
export function templatesCopy(context: unknown): { intro: string; footnote: string } {
  return isPersonal(context)
    ? { intro: PERSONAL_TEMPLATES_INTRO, footnote: PERSONAL_TEMPLATES_FOOTNOTE }
    : { intro: TEMPLATES_INTRO, footnote: TEMPLATES_FOOTNOTE };
}

/** Whether the server's list says who owns each template (the tabs show only then). */
export function hasOwnership(rows: readonly TemplateRowModel[]): boolean {
  return rows.some((r) => r.template.ownership === 'mine' || r.template.ownership === 'shared');
}

/**
 * Search (name, category, description), the My / Shared tab (only while the server
 * reports ownership), favorites first.
 */
export function filterTemplateRows(
  rows: readonly TemplateRowModel[],
  query: string,
  tab: TemplateTab | null,
): TemplateRowModel[] {
  const q = query.trim().toLowerCase();
  const out = rows.filter((r) => {
    if (tab && hasOwnership(rows) && r.template.ownership !== tab) return false;
    if (!q) return true;
    return [r.title, r.meta, r.description].some((x) => (x ?? '').toLowerCase().includes(q));
  });
  return out.sort((a, b) => Number(b.template.favorite === true) - Number(a.template.favorite === true));
}

export interface TemplateRowModel {
  readonly template: SenderTemplate;
  readonly title: string;
  /** "{category} · {n} signers · {n} documents[ · {n} copies]", from returned values only. */
  readonly meta: string | null;
  readonly description: string | null;
  readonly accessibilityLabel: string;
}

export type TemplatesView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly message: string }
  /** M-A12 W1-F — Personal without templates: the plans prompt, never an error. */
  | { readonly kind: 'upsell'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'empty'; readonly message: string; readonly note: string | null }
  | {
      readonly kind: 'list';
      readonly rows: readonly TemplateRowModel[];
      readonly note: string | null;
    };

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * Why the sender context says templates can't be used, or null when it says they can.
 * The plan capability comes first (as the server checks it), then the permission.
 */
export function contextRefusal(context: unknown): string | null {
  const c = rec(context);
  if (rec(c['features'])['templates'] !== true) return FEATURE_UNAVAILABLE;
  if (rec(c['permissions'])['templates'] !== true) return NO_TEMPLATE_PERMISSION;
  return null;
}

/** Copy for a refusal of the template routes, keyed by the server's reason / code. */
export function libraryRefusal(input: { readonly reason: string; readonly code: string }): string {
  if (input.code === 'ESIGN_FEATURE_NOT_AVAILABLE' || input.reason === 'ESIGN_FEATURE_NOT_AVAILABLE') {
    return FEATURE_UNAVAILABLE;
  }
  if (input.code === 'INSUFFICIENT_PERMISSIONS' || input.reason === 'INSUFFICIENT_PERMISSIONS') {
    return NO_TEMPLATE_PERMISSION;
  }
  return refusalMessage(input);
}

/** The note for document types the server reports as not usable right now. */
export function unavailableNote(
  unavailable: readonly { readonly reason: string }[],
): string | null {
  const n = unavailable.length;
  if (n === 0) return null;
  const selection = unavailable.every((u) => u.reason === 'TEMPLATE_SELECTION_REQUIRED');
  const what = n === 1 ? '1 more template' : `${n} more templates`;
  return selection
    ? `${what} can’t be used until an admin chooses ${n === 1 ? 'it' : 'them'} on the web.`
    : `${what} can’t be used right now. An admin can check ${n === 1 ? 'it' : 'them'} on the web.`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The row's metadata line (prototype Templates row; M-A6 §3.7):
 * "{category} · {n} signers · {n} documents", plus " · {n} copies" when the template has
 * CC roles. Every part is a value the backend returned; a part it did not return is left
 * out. A server without the M-A6 list metadata keeps "{document type} · Version {n}".
 */
export function templateMeta(t: SenderTemplate): string | null {
  const counts = t.signerRoleCount !== null || t.documentCount !== null;
  const parts = [
    t.category ?? (t.documentType || null),
    t.signerRoleCount !== null ? plural(t.signerRoleCount, 'signer', 'signers') : null,
    t.documentCount !== null ? plural(t.documentCount, 'document', 'documents') : null,
    t.ccRoleCount !== null && t.ccRoleCount > 0 ? plural(t.ccRoleCount, 'copy', 'copies') : null,
    !counts && t.versionNumber !== null ? `Version ${t.versionNumber}` : null,
  ].filter((x): x is string => !!x);
  return parts.length ? parts.join(' · ') : null;
}

export function templateRow(t: SenderTemplate): TemplateRowModel {
  const meta = templateMeta(t);
  return {
    template: t,
    title: t.name,
    meta,
    description: t.description,
    accessibilityLabel: [t.name, meta, t.description].filter(Boolean).join('. '),
  };
}

export function templatesView(input: {
  readonly context: unknown;
  readonly contextLoading: boolean;
  readonly library: TemplateLibrary | undefined;
  readonly libraryLoading: boolean;
  readonly error: unknown;
}): TemplatesView {
  if (input.contextLoading && input.context === undefined) return { kind: 'loading' };
  if (input.context !== undefined) {
    const refused = contextRefusal(input.context);
    if (refused === FEATURE_UNAVAILABLE && isPersonal(input.context))
      return { kind: 'upsell', message: PERSONAL_TEMPLATES_PROMPT };
    if (refused)
      return {
        kind: 'unavailable',
        message: isPersonal(input.context) ? PERSONAL_NO_PERMISSION : refused,
      };
  }
  if (input.error) {
    return {
      kind: 'error',
      message: isApiError(input.error)
        ? refusalMessage(input.error)
        : 'Templates couldn’t be loaded. Try again.',
    };
  }
  const lib = input.library;
  if (!lib) {
    return input.libraryLoading || input.context === undefined
      ? { kind: 'loading' }
      : { kind: 'error', message: 'Templates couldn’t be loaded. Try again.' };
  }
  if (lib.kind === 'unavailable') return { kind: 'unavailable', message: libraryRefusal(lib) };
  const note = unavailableNote(lib.unavailable);
  if (lib.items.length === 0)
    return { kind: 'empty', message: isPersonal(input.context) ? PERSONAL_NO_TEMPLATES : NO_TEMPLATES, note };
  return { kind: 'list', rows: lib.items.map(templateRow), note };
}
