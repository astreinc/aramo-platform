import { ApiError } from '@aramo/fe-foundation';

// DOC-TEMPLATE-LIB-1 T-2 — governed template/catalog refusal → operator-legible message.
export function templateErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.code === 'TEMPLATE_PREVIEW_REQUIRED') return 'Preview the current draft before publishing it.';
  if (e.code === 'TEMPLATE_DRAFT_ALREADY_EXISTS') return 'This template already has an open draft.';
  if (e.code === 'TEMPLATE_IMMUTABLE') return 'This version is published and can no longer be edited.';
  if (e.code === 'TEMPLATE_BINDING_UNSUPPORTED') {
    const keys = e.details?.['keys'];
    const key = e.details?.['binding_key'];
    const list = Array.isArray(keys) ? keys.join(', ') : typeof key === 'string' ? key : '';
    return `The content uses a variable that is not in the catalog${list !== '' ? `: ${list}` : ''}.`;
  }
  const reason = e.details?.['reason'];
  const reasonSuffix = typeof reason === 'string' && reason.length > 0 ? ` (${reason})` : '';
  return `${e.message}${reasonSuffix}`;
}
