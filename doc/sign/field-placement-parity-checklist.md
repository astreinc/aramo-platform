# Field placement: behaviour-parity checklist (FIELD-PARITY-1 P1-5, P2-1..P2-6, P3)

Source: `Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED` §4 P1-5, §5 P2-1..P2-6, §6 (Phase 3), §8 item 5, rulings R-1, R-2, R-3, R-8.

As of P1-5, sign-web Prepare (`apps/sign-web/src/workspace/pages/PrepareEditor.tsx`) and the console fixed-form Studio (`libs/document-templates-web/src/fixed-form/FixedFormStudio.tsx`) both host one shared web editor, `libs/field-placement-web` (`PlacementEditor`). So the two web columns below show the same behaviour, except where a row names a host option.

Mobile (`mobile/sign/src/features/editor`, React Native) cannot use DOM components and keeps its own editor in this phase. It already uses the same catalog (`@aramo/sign-fields` via `@aramo/sign-client`). The **Mobile** column records where it differs from the web editor.

Legend:
- ✔ — present.
- ✗ — absent.
- ◐ — present with the difference noted.
- P2 — Phase 2 (§5), not built in that column yet (mobile: a follow-up, see the end of this file).

## 1. Palette and field types
| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 1.1 | The palette is the catalog projection for its surface (`fieldTypesFor`) | ✔ `send_web` (17 types since P3) | ✔ `template_fixed_form` (17 types since P3) | ✔ `send_mobile` tool tiers, 17 types since P3 (held equal by `editorReducer.test.ts`) |
| 1.2 | Default size and required default come from the catalog `FIELD_DEFAULTS` (P1-0) | ✔ | ✔ | ✔ |
| 1.3 | PAYMENT is never in the palette (Prepare cannot author an amount); an API-placed one is shown locked (P1-6) | ✔ | ✔ (no template surface allows it) | ✔ |
| 1.4 | A stored field the editor can't author (an API-placed PAYMENT; since P3 also an engine row with no recipient or size, such as an S2S ACKNOWLEDGEMENT) is shown locked: it can't be moved or edited, can be deleted, and is sent back exactly as stored | ✔ | n/a (none can be stored) | ✔ (kept on the draft, not drawn) |
| 1.5 | Palette labels and order are host copy; glyphs come from the catalog | ✔ | ✔ (SIGN_DATE shown as "Date") | ◐ own labels |

## 2. Placing
| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 2.1 | Pick a type, then click or tap the page to place it, centred on the pointer and clamped to the page | ✔ (`paletteMode="arm"`) | ✗ (`paletteMode="add"`, see 2.2) | ✔ tap |
| 2.2 | A palette click adds the field at once, in view on the target page | ✗ (arm mode) | ✔ | ✗ |
| 2.3 | Keyboard and accessibility path: "Place on page N (keyboard)" places the armed type | ✔ (now lands in view, see 3.3) | ✔ (palette buttons are keyboard-operable) | ◐ "place at centre" button |
| 2.4 | A new field is assigned to the active recipient or role ("Placing for" or "For" list, with per-assignee field counts) | ✔ | ✔ (was a select) | ✔ signer chips |
| 2.5 | A field may have no assignee | ✗ | ✔ "No role" | ✗ |
| 2.6 | Text prefilled from a template variable ("Filled by → Prefilled: …"); Required is then disabled | n/a | ✔ | n/a |

## 3. Viewport (P0-1)
| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 3.1 | The page column scrolls on its own; the panels and top bar stay visible | ✔ (`fitHeight`, new) | ✔ (`--ffs-viewport-offset`) | n/a (one-column screen) |
| 3.2 | The target page follows the view (the page with the largest visible area); clicking a page selects it | ✔ (new) | ✔ | ◐ previous/next page buttons |
| 3.3 | A new field lands in the visible part of the target page (inset 72pt, cascading), and is scrolled into view | ✔ (new, keyboard path) | ✔ | ◐ page centre |
| 3.4 | At or below 1100px: stacked one-column layout, normal page scrolling | ✔ (was 1180px / 899px breakpoints) | ✔ | n/a |
| 3.5 | Zoom − / + (60–160%) | ✔ | ✔ (new) | ◐ 100 / 150 / 200% |
| 3.6 | Page list: jump to a page | ✔ (shown when there are 2 or more pages) | ✔ (new, 2 or more pages) | ◐ previous/next |

## 4. Editing
| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 4.1 | Drag to move; drag the corner to resize; the box is kept inside the page (minimum 14pt) | ✔ | ✔ | ✔ |
| 4.2 | Drag rounding: whole points, top-left frame | ✔ (`precision="integer"`) | — | ◐ own rounding |
| 4.3 | Drag rounding: hundredths, PDF-native frame | — | ✔ (`precision="hundredths"`) | — |
| 4.4 | Arrow keys move 2pt, Shift+arrow 10pt (the whole selection when the focused field is in it) | ✔ | ✔ (new) | ◐ on-screen buttons, 4pt |
| 4.5 | Alt+arrows resize (2pt, Shift 10pt) (the whole selection) | ✔ | ✔ (new) | ◐ on-screen buttons |
| 4.6 | Delete or Backspace removes the focused field (the whole selection) | ✔ | ✔ (new) | ◐ ✕ on the field |
| 4.7 | Escape deselects; Enter or Space selects; focus selects | ✔ | ✔ | n/a |
| 4.8 | Undo: button, plus Cmd/Ctrl+Z outside text controls | ✔ (20 steps) | ✔ (new, 20 steps) | ◐ button, 30 steps |
| 4.9 | One drag is one undo step (also when it moves many fields) | ✔ | ✔ | ✔ |
| 4.10 | Redo: button, plus Shift+Cmd/Ctrl+Z or Ctrl+Y outside text controls (P2-3) | ✔ (new) | ✔ (new) | P2 |
| 4.11 | Duplicate, copy/paste, Repeat down, multi-select, align, snap | ✔ see §8 | ✔ see §8 | P2 |

## 5. Field settings (inspector)
The settings shown are the catalog's `fieldSettingsOf(type)` intersected with the host's capabilities.

| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 5.1 | Reassign the field to another recipient or role | ✔ | ✔ | ✔ |
| 5.2 | Required toggle (check-box groups share it) | ✔ | ✔ | ✔ |
| 5.3 | Name: "comes from profile / signer types it" (`name_mode`) | ✔ | ✔ (since P1-3) | ✔ |
| 5.4 | Check box label, group, rule (any / one), minimum; group consistency rules | ✔ | ✔ (since P1-3) | ✔ |
| 5.7 | Phase 3 settings (label on every type, tooltip, placeholder, validation, font size, data name, options, sender-filled) | ✔ see §11 | ✔ see §11 | ✔ see §11 |
| 5.5 | Size and page shown; field key shown | ◐ size + page | ✔ size + page + key | ◐ |
| 5.6 | Delete button | ✔ | ✔ | ◐ ✕ on the field |

## 6. Saving
| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 6.1 | Autosave 600ms after the last edit, saving the full field set through the host's own call | ✔ `PUT …/fields` | ✔ (new) `saveLayout` | ✗ saves on Save draft / Review / Send (`sendFlowController.sync`) |
| 6.2 | Save state shown ("Saving… / Saved / Not saved") | ✔ | ✔ (new) | ◐ |
| 6.3 | Explicit Save button | ✗ | ✔ (saves now) | ✔ Save as draft |
| 6.4 | The payload has the same field shape as before P1-5 | ✔ (`prepare-wire.spec.ts`) | ✔ (`fixed-form-placement.ts`) | n/a |

## 7. Accessibility
| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 7.1 | Each field is a focusable button labelled "<type> field for <who>, page N"; pressed state = selected | ✔ | ✔ (labels changed from "<type> · <role>") | ✔ accessibility labels |
| 7.2 | Focus moves to a new field; after a delete, focus returns to the page column | ✔ (new) | ✔ (new) | ◐ |
| 7.3 | Live announcements: field added, field deleted, undone | ✔ (new) | ✔ (new) | ◐ |
| 7.4 | Labelled panes (left, pages, right) and labelled controls | ✔ | ✔ ("Form setup", "Form pages", "Field and checks") | ✔ |

## 8. Phase 2: duplicate, multi-select, arrange, snap (P2-1..P2-3)
Both web hosts get these from the shared editor (`libs/field-placement-web`), so the two web columns match. Each action is one undo step, has a labelled button as well as a key, and announces its result.

| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 8.1 | Duplicate the selection (button, Cmd/Ctrl+D): 10pt right and down, new ids from the host (`newFieldId`), selected and focused, "N fields duplicated." | ✔ | ✔ (ids run on: `text_2`, `text_3` …) | P2 |
| 8.2 | Copy (button, Cmd/Ctrl+C) and Paste (toolbar button, Cmd/Ctrl+V) onto the page in view at the same position; pasting back onto the source page steps 10pt each time; clamped to a smaller page | ✔ | ✔ | P2 |
| 8.3 | Repeat down: N copies (1 to 50) of the selected field or row at a set distance (points, top to top; suggested: row height + 6); rows that would leave the page are not added and are announced ("2 rows added. 7 rows did not fit on the page.") | ✔ | ✔ | P2 |
| 8.4 | Copies keep type, size, assignee or prefill binding, required and settings; a duplicated or pasted check box stays in its group; Repeat down gives each new row its own group (`<key>_2`, `<key>_3` …, the next free one, cut to the host's group-key limit) | ✔ | ✔ | P2 |
| 8.5 | Locked (engine-only) and hidden fields are never duplicated, copied or arranged (they can still be deleted) | ✔ | n/a (none can be stored) | P2 |
| 8.6 | Multi-select: Shift+click, Shift+Enter / Shift+Space, drag-a-box on the page background (Shift adds), Cmd/Ctrl+A (the page's fields) | ✔ | ✔ | P2 |
| 8.7 | Move (drag or arrows), resize (corner or Alt+arrows), delete and reassign the whole selection; a group stops together at the page edge | ✔ | ✔ | P2 |
| 8.8 | Align left / centre / right / top / middle / bottom; distribute across / down (3 or more); same width / height (copies the first selected field) — per page | ✔ | ✔ | P2 |
| 8.9 | Snap while dragging to other fields' edges and centres, with guide lines; optional 10pt grid (toolbar "Grid"); "Snap" toggle; Shift turns snapping off for a drag | ✔ | ✔ | P2 |
| 8.10 | Positions are clamped to the page and rounded by the host's rule (4.2 / 4.3) | ✔ whole points | ✔ hundredths | P2 |
| 8.11 | The saved field shape and the save call are unchanged (more fields are just more fields) | ✔ (`prepare-wire.spec.ts`) | ✔ (`fixed-form-placement.spec.ts`) | n/a |
| 8.12 | "Keyboard shortcuts" list in the left panel (the `KEYMAP` table) | ✔ | ✔ | n/a |

## 9. Phase 2: auto-detect suggestions (P2-4)
The detector is one deterministic module, `libs/sign-fields/src/lib/field-detect.ts` (`detectFields`). It uses no model and makes no network call. It reads the text layer and the drawn rectangles (`libs/documents-rendering` `extractTextLayer`, `extractPageGraphics`). Both routes run it:
- Sign: `GET /v1/sign/sender/envelopes/{id}/documents/{documentId}/field-suggestions?detect=all`. Without `detect`, the answer is the unchanged M-A14 one that self-sign uses.
- Console: `GET /platform/document-templates/versions/{versionId}/fixed-form/field-suggestions`.

Both web hosts get the editor half from the shared editor. Which ghosts are pending is decided by one rule, `pendingSuggestions`, shared by web and mobile.

| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 9.1 | "Find fields" asks the server's detector for the document(s) | ✔ each envelope document, `detect=all` | ✔ the version's PDF | ✔ Send flow, each uploaded document, `detect=all` (a document not uploaded yet has no loader) |
| 9.2 | Detected: labels (Signature, Sign here, Initials, Name, Printed name, Title, Email, Company, Date), underscore lines, empty boxes and table cells, ☐ □ glyphs, on every page; a rotated page is skipped and reported (`skipped_pages`) | ✔ | ✔ | ✔ |
| 9.3 | Only the host palette's types are offered as ghosts (a type the host lacks is never shown; on the console, a "Title:" / "Email:" label arrives as TEXT) | ✔ `send_web` | ✔ `template_fixed_form` | ✔ authoring types |
| 9.4 | Ghosts: dashed boxes under the fields, each a labelled button ("Suggested signature field next to the label “Signature”, page 1") | ✔ | ✔ | ✔ (accessibility actions: add / dismiss) |
| 9.5 | Accept one: click, Enter or Space → an ordinary field at the box, of its type, with the catalog's required default, for the assignee being placed for; selected | ✔ | ✔ (or "No role" when none) | ✔ tap |
| 9.6 | Accept all on the page in view / Accept all: ONE undo step | ✔ | ✔ | ✔ ("Accept this page" / "Accept all") |
| 9.7 | Dismiss one (Delete / Backspace / ×) or Dismiss all; dismissing is not an edit | ✔ | ✔ | ✔ (press and hold / "Dismiss all") |
| 9.8 | A ghost a field already covers is not offered; undoing an accept brings the ghost back | ✔ | ✔ | ✔ |
| 9.9 | Accepting needs an assignee (or a host that allows none); the reason is announced | ✔ | ✔ (No role allowed) | ✔ (active signer) |
| 9.10 | Results announced (found N / none / not available / N added / dismissed) | ✔ | ✔ | ✔ live region |
| 9.11 | Read-only editor: no suggestions | ✔ | ✔ | n/a |
| 9.12 | Self-sign (mobile M-A14 banner) | n/a | n/a | ◐ unchanged: the default route answer, SIGNATURE / SIGN_DATE only, at most 6 |

## 10. Phase 2: upload options (P2-5 fillable-PDF import, P2-6 text tags)
One web component, `libs/field-placement-web` `UploadFieldOptions` / `FieldImportResult`, holds the options and the result. All the words come from `libs/sign-fields` `field-import-copy.ts`, so web and mobile use the same copy.

| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 10.1 | "Import fields from a fillable PDF" and "Apply text tags ({{…}})" check boxes, off by default | ✔ document step (step 1) | ✔ under "Upload PDF…" / "Replace PDF…" | ✗ follow-up (see below) |
| 10.2 | A flag is sent only when ticked; with neither ticked, the upload body is exactly as before | ✔ | ✔ | — |
| 10.3 | Result: "N fields added · N warnings · active content removed", each warning code in plain language (all 17 codes) with the tag or field name and page, and the removed PDF keys | ✔ per uploaded file | ✔ (closable) | — |
| 10.4 | Short in-app text-tag help (syntax, examples, types; full page `doc/sign/text-tags.md`) | ✔ | ✔ | — |

## 11. Phase 3: new types and settings (§6, rulings R-1, R-2, R-3, R-6, R-7)
One rule decides which settings a type shows on every editor: the catalog's `fieldSettingsOf(type)` (`@aramo/sign-fields`, re-exported by `@aramo/sign-client`), intersected with what the host offers. The web editor's panel is `libs/field-placement-web/src/FieldSettingsPanel.tsx`; the app's sheet is `mobile/sign/src/features/editor/FieldSettingsSheet.tsx`. Every editor runs the server's ONE settings rule (`parseFieldSettings`) on the field it is editing and shows the refusal message before saving.

| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 11.1 | Nothing pending: `P3_PENDING_WEB_TYPES` / `P3_PENDING_MOBILE_TOOLS` are empty | ✔ | n/a | ✔ |
| 11.2 | ACKNOWLEDGEMENT is on the palette (T-2, R-2) | ✔ | ✔ | ✔ |
| 11.3 | DATE (a chosen date), DROPDOWN, RADIO, NUMBER and MULTILINE_TEXT are on the palette (T-3..T-7) | ✔ | ✔ ("Chosen date") | ✔ Send flow; ◐ Sign a document keeps its row (its fill sheet takes only the older types) |
| 11.4 | Label (S-1) on every type that takes it; for RADIO it is the option text | ✔ | ✔ | ✔ commits when editing ends |
| 11.5 | Tooltip (S-1), placeholder (S-2), data name (S-9) | ✔ | ✔ | ✔ |
| 11.6 | Validation preset per type (TEXT: email, phone, US ZIP, max length; MULTILINE_TEXT: max length; NUMBER: number range; DATE: date range), with its parameters; a parameter is sent only while its preset is chosen | ✔ | ✔ | ✔ (date bounds typed as YYYY-MM-DD) |
| 11.7 | Font size auto (default) or fixed 6..36pt (S-7) | ✔ auto / fixed + points | ✔ | ✔ auto / fixed + −/+ |
| 11.8 | DROPDOWN choices: start with two; add, remove, reorder; value + label (a blank value is the label) | ✔ | ✔ | ◐ labels only (a choice's value follows its label; a stored value is kept) |
| 11.9 | NUMBER format: number or money; currency (ISO code, default USD) and decimals (money default 2) | ✔ | ✔ | ✔ |
| 11.10 | RADIO: a new one gets its own group (always select-one); "Add option" adds the next option just below in the same group, as one undo step; the group shares required, read-only and sender-filled; no rule or minimum control | ✔ | ✔ | ✔ |
| 11.11 | Sender-filled (S-5, dark) shown only when the server says `sender_filled_fields_enabled`; then the sender types the value (input by type: date, number, choice, chosen option, check) and may make it read-only (S-4) | ✔ from the envelope detail | ✔ from the fixed-form view (`sender_filled_fields_enabled`, FIELD-PARITY-2 A-4); a template stores no sender value, and a stored sender-filled field round-trips | ✔ from the envelope detail (a draft not yet read from the server: off) |
| 11.12 | The sender's value goes on the wire only with a sender-filled field; any other value is never sent | ✔ | n/a (a template has no sender value) | ✔ |
| 11.13 | A stored field keeps every setting: untouched fields go back unchanged | ✔ | ✔ byte-equal (`fixed-form-placement.spec.ts` FP3-S-1) | ✔ (a preserved field also keeps its settings and value) |
| 11.14 | Conditional display (S-8) and ATTACHMENT (T-8) | ✗ follow-up (R-7, R-6) | ✗ | ✗ |
| 11.15 | Fillable-PDF import: a radio group becomes a RADIO group; multi-line text becomes MULTILINE_TEXT; a dropdown stays TEXT until the reader and upload hosts carry its choices | ✔ | ✔ | n/a (§10) |
| 11.16 | Text tags: `date_chosen`, `number`, `multiline`, `acknowledgement` (and aliases); DROPDOWN / RADIO tags are refused (`doc/sign/text-tags.md`) | ✔ | ✔ | n/a (§10) |

### The keymap (one for both web hosts; `libs/field-placement-web/src/lib/keymap.ts` `KEYMAP`)
| Keys | Action |
|---|---|
| Arrow keys | Move the selection 2pt |
| Shift+Arrow keys | Move the selection 10pt |
| Alt+Arrow keys | Resize the selection (2pt; with Shift 10pt) |
| Delete / Backspace | Delete the selection |
| Enter / Space | Select the focused field |
| Shift+Enter / Shift+Space | Add or remove the focused field from the selection |
| Escape | Clear the selection |
| Cmd/Ctrl+A | Select every field on the page |
| Cmd/Ctrl+D | Duplicate the selection |
| Cmd/Ctrl+C | Copy the selection |
| Cmd/Ctrl+V | Paste onto the page in view (same position) |
| Cmd/Ctrl+Z | Undo |
| Shift+Cmd/Ctrl+Z or Ctrl+Y | Redo |
| Shift while dragging | Turn snapping off for this drag |
| Shift+click | Add or remove a field from the selection |

Cmd/Ctrl+A, D, C and V act only while focus is in the editor (or on nothing), so the host page keeps its own copy and paste; none of the shortcuts act inside a text control.

## Mobile follow-ups (not in P1-5)
These rows are where mobile differs from the web editor:
- 2.2 / 3.3 — in-view placement.
- 4.4 — nudge step (4pt on mobile, 2pt on web).
- 4.8 — undo depth (30 on mobile, 20 on web).
- 6.1 — autosave.
- 4.10 and §8 (P2-1..P2-3) — redo, duplicate, copy/paste, Repeat down, multi-select, arrange and snap. The pure helpers (`lib/clone.ts`, `lib/arrange.ts`, the commands in `lib/editor-state.ts`) are DOM-free and can be reused by the mobile reducer.
- §10 (P2-5 / P2-6 upload options) — the app uploads documents offline-first. A document is uploaded later by the draft sync (`features/send/syncDraft.ts`), after the sender may already have placed fields on the device. The sync then replaces the envelope's whole field set (`PUT …/fields`) with the device's fields. So fields imported on upload would be overwritten unless the editor first merges `field_import.fields` into the draft. The upload route and the generated client already accept `import_fields` / `apply_text_tags` (`SenderUploadedDocument.field_import`), and the copy is shared (`@aramo/sign-client` re-exports `UPLOAD_OPTION_COPY`, `fieldImportSummary`, `fieldImportWarningText`). The remaining work is the merge plus the two switches on the add-documents sheet.

Aligning them is a mobile change. Per §8 item 5 it is tracked against this checklist; it is not built here.
