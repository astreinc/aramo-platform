# Text tags and fillable-PDF import

FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 P2-5 and
P2-6, ruling R-5. These are two ways to get fields onto a document without placing each one by
hand. Both run only when the upload asks for them, and both are off by default. Without the flags,
an upload is stored and answered exactly as before.

| Upload | Route | Flags |
|---|---|---|
| Console fixed form (platform Form Studio) | `PUT /platform/document-templates/versions/{versionId}/fixed-form/pdf` | `import_fields`, `apply_text_tags` (JSON booleans next to `content_base64`) |
| Aramo Sign envelope document | `POST /v1/sign/sender/envelopes/{id}/documents` | `import_fields`, `apply_text_tags` (JSON booleans next to `content_base64`) |

When at least one flag is set, the response carries `field_import`, which holds:
- `fields`: the fields created, each with `source` (`pdf_form` or `text_tag`) and `source_name`;
- `warnings`: one named warning for each thing found but not imported, or imported differently;
- `stripped`: the active-content keys that were removed.

The rules live in one place, `libs/sign-fields/src/lib/field-import.ts`. The PDF work (reading
the form, stripping, flattening, covering) lives in
`libs/documents-rendering/src/lib/pdf-form-import.ts`.

## Text tags (`apply_text_tags`)

Type a tag into the source document (Word, Google Docs, anything that exports a PDF with real
text):

```
{{type:role[:required|optional][:label=Caption text]}}
```

- **type** is required. It can be one of the lower-case names below or a catalog key in any case
  (for example `SIGNATURE`). It must be a type the document accepts (see the table). An unknown
  type, or a type the document does not accept, creates no field. That tag is left visible and
  reported (`text_tag_type_unknown`, `text_tag_type_not_allowed`).
- **role** says who fills the field. Matching ignores case.
  - On a fixed form, the role matches a signer role's key or label.
  - On an envelope, the role matches a signing recipient's name, email or template role.
  - A role that matches nobody is reported as `text_tag_role_unknown`. On a fixed form the field
    then has no role; on an envelope it goes to the first signing recipient. A tag with no role is
    reported as `text_tag_role_missing`.
- **required** or **optional** overrides the type's default (`FIELD_DEFAULTS`).
- **label=** sets the field's label (a check box's caption). Everything after `label=` belongs to
  the label, so it may contain `:`. Since FIELD-PARITY-1 Phase 3 every type takes a label except
  Payment; on a type without one it is ignored and reported (`text_tag_label_not_applicable`).
  An unrecognised option is ignored and reported (`text_tag_option_unknown`).

| Tag name | Field type | Fixed form | Envelope |
|---|---|---|---|
| `signature` | SIGNATURE | ✔ | ✔ |
| `initials` | INITIALS | ✔ | ✔ |
| `date`, `sign_date` | SIGN_DATE (the signing date; kept as `date` for compatibility) | ✔ | ✔ |
| `name`, `signer_name` | SIGNER_NAME (the signer's printed name) | ✔ | ✔ |
| `text` | TEXT | ✔ | ✔ |
| `checkbox` | CHECKBOX | ✔ | ✔ |
| `title` | TITLE | ✔ | ✔ |
| `company` | COMPANY | ✔ | ✔ |
| `email` | EMAIL | ✔ | ✔ |
| `first_name` | FIRST_NAME | ✔ | ✔ |
| `last_name` | LAST_NAME | ✔ | ✔ |
| `date_chosen`, `chosen_date` | DATE (a date the signer picks, not the signing date) | ✔ | ✔ |
| `number` | NUMBER (plain; set the money format in the editor) | ✔ | ✔ |
| `multiline`, `multiline_text`, `paragraph` | MULTILINE_TEXT | ✔ | ✔ |
| `acknowledgement`, `acknowledge` | ACKNOWLEDGEMENT | ✔ | ✔ |

FIELD-PARITY-1 Phase 3 (ruling R-1) put the profile types on fixed forms and added the last four
rows. A **dropdown** or **radio button** cannot come from a tag, because a tag cannot carry a
dropdown's choices or a radio button's group. A `{{dropdown:…}}` or `{{radio:…}}` tag (or the
catalog key in any case) creates no field. It is left visible and reported as
`text_tag_type_not_allowed`; place those fields in the editor. The list is
`TEXT_TAG_UNSUPPORTED_TYPES`.

Payment is never created from a tag.

Examples:

```
Seller: {{signature:Seller}}          Date: {{date:Seller}}
Buyer name: {{text:Buyer:required}}
Closing date: {{date_chosen:Buyer:required}}      Notes: {{multiline:Buyer:optional}}
{{checkbox:Buyer:label=I have read the disclosure}}
{{initials:buyer@example.com:optional}}
```

**Size and position.** Each field takes the box of the tag's own characters, grown to at least 8
points each way and kept on the page. A check box is a square as tall as the tag, at the tag's
left edge. To get a bigger field, make the tag text bigger or longer.

**Covering (ruling R-5).** Every tag that becomes a field is painted over with a white rectangle on
the stored PDF: the tag's box plus 1 point on each side. The original upload bytes are not kept.
Note: the tag's characters are still in the page content underneath the white box. Text
extraction (for example "Find in document") can still find them, but they are not visible.

**Limits.**
- Tags are read from the PDF's text layer. A scanned or image-only PDF has none, so no tags are
  found. If the text cannot be read at all, the warning is `text_tags_unreadable`.
- A tag must sit on one line, with at most 300 characters between the braces and no `{` or `}`
  inside. A tag that the source split into pieces on one line is joined back together.
- Tags on a rotated page are not read (`text_tag_rotated_page`).

## Fillable-PDF import (`import_fields`)

When the PDF has form fields (AcroForm), each visible widget becomes a field at the same place. The
field's name is kept: on a fixed form it becomes the `field_key` (lower_snake, made unique); a
check box's tooltip, or else its name, becomes its label. Then the form is flattened: each widget's
appearance is drawn into the page, and the form and its widgets are removed.

| PDF form field | Catalog field |
|---|---|
| Text | TEXT |
| Multi-line text | MULTILINE_TEXT (FIELD-PARITY-1 Phase 3) |
| Check box | CHECKBOX (label = tooltip, else name) |
| Radio group | one RADIO per option, in one radio group (always select-one; group key = the radio name, made unique on the document; label = the option). Before Phase 3 this was a SELECT_ONE check-box group. |
| Dropdown (combo box) | TEXT. A DROPDOWN needs its choices, and neither the form reader nor the upload routes carry a form field's options yet (a follow-up). |
| List box | TEXT (same reason) |
| Signature (unsigned) | SIGNATURE |
| Signature already signed | not imported (`pdf_field_signed`) |
| Push button | not imported (`pdf_field_type_unsupported`) |
| Read-only field | not imported (`pdf_field_read_only`) |
| Hidden widget | not imported (`pdf_field_hidden`) |

Imported form fields have no signer yet:
- on a fixed form, they have no role, and the author assigns roles in the Studio;
- on an envelope, they go to the first signing recipient (`field_assigned_to_first_recipient`),
  and the sender reassigns them in Prepare.

**Security.** Nothing in the PDF is ever run. The file is parsed as data. Before the existing
safe-upload gates decide, the import removes the form's active content:
- the whole `/AcroForm`, including `/XFA`, the calculation order, and every field's `/A` and
  `/AA` actions;
- every widget's actions;
- each page's `/AA`;
- the document's `/AA`;
- a JavaScript `/OpenAction`;
- the document JavaScript name tree (`/Names /JavaScript`).

Objects that nothing references any more are dropped. The file is then written fresh, so earlier
revisions are gone.

Anything else that counts as active content stays in place, and the existing gates refuse it
exactly as before. That includes a link's Launch action, embedded files, rich media and a
non-JavaScript `/OpenAction`.

An XFA-only form (an XFA stream and no AcroForm widgets) cannot be flattened into anything
meaningful, so it is refused with reason `xfa_only_form`. The flattened PDF (and, for tags, the
covered PDF) then passes the same gates as any other upload.

**Envelope without a recipient.** If an envelope upload finds fields but the envelope has no
signing recipient, the upload is refused with `422` and reason `field_import_needs_recipient`.
Nothing is stored.

## In the apps

Both web uploads offer the two options as check boxes. Both are off by default, and a flag is sent only when its box is ticked:
- the console form Studio, under "Upload PDF…" / "Replace PDF…";
- the sign-web envelope document step.

After an opted-in upload, the app shows:
- how many fields were added;
- each warning in plain language (the copy is `libs/sign-fields/src/lib/field-import-copy.ts`);
- what was removed from the PDF.

The short syntax summary under "How to write text tags" is `TEXT_TAG_HELP` in the same file. The Aramo Sign app does not offer the options yet; see `doc/sign/field-placement-parity-checklist.md` §10.
