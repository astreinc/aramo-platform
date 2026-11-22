// FIELD-PARITY-1 §5 P2-5 / P2-6 — the user-facing words for the opt-in upload options and their
// result (`field_import`), shared by every UI that offers them (console form Studio, sign-web
// envelope upload; mobile when its upload offers them): one place for the option labels, the
// plain-language copy of each warning code, the summary line and the short text-tag help (the
// long form is doc/sign/text-tags.md).
//
// Pure TypeScript ESM, no dependency (scope:shared).

import { FIELD_IMPORT_WARNING_CODES, type FieldImportWarningCode } from './field-import.js';

export const UPLOAD_OPTION_COPY = {
  import_fields: {
    label: 'Import fields from a fillable PDF',
    help: 'Form fields in the PDF become fields here, at the same places. The PDF is then flattened; scripts and actions are removed.',
  },
  apply_text_tags: {
    label: 'Apply text tags ({{…}})',
    help: 'Tags typed in the document, such as {{signature:Buyer}}, become fields and are covered on the stored PDF.',
  },
} as const;

/** The plain-language copy of every warning code (the server's `message` adds the specifics). */
export const FIELD_IMPORT_WARNING_COPY: Readonly<Record<FieldImportWarningCode, string>> = {
  pdf_field_type_unsupported: 'A form field of a kind we can’t import (for example a list or a button) was skipped.',
  pdf_field_type_not_allowed: 'A form field of a type this document can’t hold was skipped.',
  pdf_field_read_only: 'A read-only form field was skipped.',
  pdf_field_hidden: 'A hidden form field was skipped.',
  pdf_field_signed: 'A form field that was already signed was skipped.',
  pdf_field_not_on_page: 'A form field that is not on any page was skipped.',
  text_tag_invalid: 'A tag could not be read, so it was left as text. Check its spelling and braces.',
  text_tag_type_unknown: 'A tag names a field type we don’t know, so it was left as text.',
  text_tag_type_not_allowed: 'A tag names a field type this document can’t hold, so it was left as text.',
  text_tag_option_unknown: 'A tag has an option we don’t know; the option was ignored.',
  text_tag_label_not_applicable: 'A tag has a label, but only check boxes take one; the label was ignored.',
  text_tag_rotated_page: 'Tags on a rotated page can’t be placed, so they were left as text.',
  text_tags_unreadable: 'The document’s text could not be read, so no tags were applied.',
  text_tag_role_missing: 'A tag has no role, so its field has no signer yet.',
  text_tag_role_unknown: 'A tag names a role that doesn’t exist here; assign its field yourself.',
  field_assigned_to_first_recipient: 'A field’s role matched no one, so it was given to the first signer.',
  too_many_fields: 'There were more fields than this document can hold; the rest were not added.',
};

/** The copy for a warning code (an unknown code from a newer server still reads sensibly). */
export function fieldImportWarningText(code: string): string {
  return (FIELD_IMPORT_WARNING_COPY as Readonly<Record<string, string>>)[code] ?? 'Something in the PDF could not be imported.';
}

export const isFieldImportWarningCode = (v: unknown): v is FieldImportWarningCode => typeof v === 'string' && (FIELD_IMPORT_WARNING_CODES as readonly string[]).includes(v);

/** The one-line result of an opted-in upload ("3 fields added · 1 warning · active content removed"). */
export function fieldImportSummary(r: { readonly fields: readonly unknown[]; readonly warnings: readonly unknown[]; readonly stripped: readonly string[] }): string {
  const n = r.fields.length;
  const parts = [n === 0 ? 'No fields were added' : `${n} field${n === 1 ? '' : 's'} added`];
  if (r.warnings.length > 0) parts.push(`${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}`);
  if (r.stripped.length > 0) parts.push('active content removed');
  return parts.join(' · ');
}

/** The in-app text-tag help (short; doc/sign/text-tags.md is the full page). */
export const TEXT_TAG_HELP = {
  syntax: '{{type:role[:required|optional][:label=Caption]}}',
  examples: ['{{signature:Seller}}', '{{date:Seller}}', '{{text:Buyer:required}}', '{{checkbox:Buyer:label=I agree}}'],
  types: 'signature, initials, date (the signing date), name, text, checkbox, title, company, email, first_name, last_name, date_chosen, number, multiline, acknowledgement',
  notes: [
    'The role matches a signer role (forms) or a recipient’s name, email or role (envelopes); case does not matter.',
    'Each field takes the size of the tag’s text. Tags that become fields are covered with white on the stored PDF.',
  ],
} as const;
