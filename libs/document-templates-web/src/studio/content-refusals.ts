import {
  CONTENT_REFUSAL_REASONS,
  INLINE_FIELD_REFUSAL_REASONS,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  type ContentRefusalReason,
  type InlineFieldRefusalReason,
} from '@aramo/template-content';

// TEMPLATE-CONTENT-2 (§3.8) — the ONE place the Studio words the server's content refusals, for
// every host (platform, organization, Sign). The reason codes come from the shared rules; any
// other error falls through to the host's own formatter.

type Reason = ContentRefusalReason | InlineFieldRefusalReason;

function reasonOf(e: unknown): { reason: Reason; keys: string[]; details: Record<string, unknown> } | null {
  if (typeof e !== 'object' || e === null) return null;
  const details = (e as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  const known: readonly string[] = [...CONTENT_REFUSAL_REASONS, ...INLINE_FIELD_REFUSAL_REASONS];
  if (typeof reason !== 'string' || !known.includes(reason)) return null;
  const raw = (details as { keys?: unknown }).keys;
  const keys = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
  return { reason: reason as Reason, keys, details: details as Record<string, unknown> };
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
    // TEMPLATE-FIELDS-1 §3.7 — the inline field refusals.
    case 'field_position_not_allowed':
      return 'A field goes in a paragraph, a list item or a table cell, never in a heading or the title.';
    case 'field_marker_mismatch':
      return 'The fields in the text and their settings do not match. Undo the last change, or delete the field and insert it again.';
    case 'field_marker_duplicate':
      return 'A field is placed twice. Delete one of them.';
    case 'signing_roles_required':
      return 'Every field needs a signing role (Roles tab), or must be filled by the sender.';
    case 'field_too_wide': {
      const where = r.details['place'] === 'table_cell' ? 'table cell' : r.details['place'] === 'list_item' ? 'list item' : 'line';
      return `The field ${String(r.details['field_key'] ?? '')} is too wide for its ${where}. Move it to a wider place (for example a paragraph, or a table with fewer columns).`;
    }
    case 'field_not_placed':
      return 'A field in the text could not be placed. Check the template and try again.';
    case 'fields_platform_only':
      return 'Fields are placed by Aramo: you can edit the wording around them, but not add, remove or change them.';
    case 'inline_fields_not_supported_for_ats':
      return 'A template used in ATS cannot have fields in its text. Remove the ATS tag, or remove the fields.';
  }
}
