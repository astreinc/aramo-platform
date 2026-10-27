// Templates screen model (M-A4 §6.4; handoff §2A "Templates"). Pure: it turns what the
// backend returned (the sender context's availability flags and the template library)
// into what the screen shows. Only returned metadata is shown (name, document type,
// version, description); nothing is derived on the device, and an unavailable state
// always carries the server's reason.
import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { SenderTemplate, TemplateLibrary } from '../send/templates';

export const TEMPLATES_INTRO =
  'Approved by your organization. Pick one to start an envelope with its documents and fields ready.';
export const TEMPLATES_FOOTNOTE =
  'Create and edit templates on the web, in Organization → Our templates.';

export const FEATURE_UNAVAILABLE = 'Templates aren’t available for your organization yet.';
export const NO_TEMPLATE_PERMISSION =
  'You don’t have access to templates. Ask an admin in your organization.';
export const NO_TEMPLATES = 'Your organization has no templates yet.';

export interface TemplateRowModel {
  readonly template: SenderTemplate;
  readonly title: string;
  /** "{document type} · Version {n}", from returned values only. */
  readonly meta: string | null;
  readonly description: string | null;
  readonly accessibilityLabel: string;
}

export type TemplatesView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly message: string }
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

export function templateMeta(t: SenderTemplate): string | null {
  const parts = [
    t.documentType || null,
    t.versionNumber !== null ? `Version ${t.versionNumber}` : null,
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
    if (refused) return { kind: 'unavailable', message: refused };
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
  if (lib.items.length === 0) return { kind: 'empty', message: NO_TEMPLATES, note };
  return { kind: 'list', rows: lib.items.map(templateRow), note };
}
