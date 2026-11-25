import { CONTENT_REFUSAL_REASONS, TABLE_MAX_COLUMNS, TABLE_MAX_ROWS, type ContentRefusalReason } from '@aramo/template-content';

// TEMPLATE-CONTENT-2 (§3.8) — the ONE place the Studio words the server's content refusals, for
// every host (platform, organization, Sign). The reason codes come from the shared rules; any
// other error falls through to the host's own formatter.

function reasonOf(e: unknown): { reason: ContentRefusalReason; keys: string[] } | null {
  if (typeof e !== 'object' || e === null) return null;
  const details = (e as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  if (typeof reason !== 'string' || !(CONTENT_REFUSAL_REASONS as readonly string[]).includes(reason)) return null;
  const raw = (details as { keys?: unknown }).keys;
  const keys = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  return { reason: reason as ContentRefusalReason, keys };
}

/** The Studio's message for a content refusal, or null when `e` is not one. */
export function contentRefusalMessage(e: unknown): string | null {
  const r = reasonOf(e);
  if (r === null) return null;
  switch (r.reason) {
    case 'content_version_downgrade':
      // An outdated Studio (a tab opened before the upgrade) tried to save older-format content.
      return 'This template was saved with a newer editor. Reload the page to get it, then make your change again.';
    case 'unsupported_content_version':
      return 'This content format is not supported. Reload the page and try again.';
    case 'content_too_large':
      return 'The document is too large to save. Remove some content or split it into separate templates.';
    case 'table_too_large':
      return `A table can have up to ${TABLE_MAX_COLUMNS} columns and ${TABLE_MAX_ROWS} rows.`;
    case 'list_too_deep':
      return 'Lists go two levels deep. Outdent the deeper items (Shift+Tab).';
    case 'unresolved_placeholder': {
      const list = r.keys.map((k) => `{{${k}}}`).join(', ');
      return `Typed placeholders are never filled in${list !== '' ? `: ${list}` : ''}. Convert them to variables or replace them before publishing.`;
    }
  }
}
