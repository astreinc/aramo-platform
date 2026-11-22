# Field placement: behaviour-parity checklist (FIELD-PARITY-1 P1-5)

Source: `Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED` §4 P1-5, §8 item 5, ruling R-8.

As of P1-5, sign-web Prepare (`apps/sign-web/src/workspace/pages/PrepareEditor.tsx`) and the console fixed-form Studio (`libs/document-templates-web/src/fixed-form/FixedFormStudio.tsx`) both host one shared web editor, `libs/field-placement-web` (`PlacementEditor`). So the two web columns below show the same behaviour, except where a row names a host option.

Mobile (`mobile/sign/src/features/editor`, React Native) cannot use DOM components and keeps its own editor in this phase. It already uses the same catalog (`@aramo/sign-fields` via `@aramo/sign-client`). The **Mobile** column records where it differs from the web editor.

Legend:
- ✔ — present.
- ✗ — absent.
- ◐ — present with the difference noted.
- P2 — Phase 2 (§5), not built in any column yet.

## 1. Palette and field types
| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 1.1 | The palette is the catalog projection for its surface (`fieldTypesFor`) | ✔ `send_web` (11 types) | ✔ `template_fixed_form` (6 types) | ✔ `send_mobile` tool tiers (held equal by `editorReducer.test.ts`) |
| 1.2 | Default size and required default come from the catalog `FIELD_DEFAULTS` (P1-0) | ✔ | ✔ | ✔ |
| 1.3 | PAYMENT is never in the palette (Prepare cannot author an amount); an API-placed one is shown locked (P1-6) | ✔ | ✔ (no template surface allows it) | ✔ |
| 1.4 | An engine-only stored field (ACKNOWLEDGEMENT; PAYMENT) is shown locked: it can't be moved or edited, can be deleted, and is sent back exactly as stored | ✔ | n/a (none can be stored) | ✔ |
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
| 4.4 | Arrow keys move 2pt, Shift+arrow 10pt | ✔ | ✔ (new) | ◐ on-screen buttons, 4pt |
| 4.5 | Alt+arrows resize (2pt, Shift 10pt) | ✔ | ✔ (new) | ◐ on-screen buttons |
| 4.6 | Delete or Backspace removes the focused field | ✔ | ✔ (new) | ◐ ✕ on the field |
| 4.7 | Escape deselects; Enter or Space selects; focus selects | ✔ | ✔ | n/a |
| 4.8 | Undo: button, plus Cmd/Ctrl+Z outside text controls | ✔ (20 steps) | ✔ (new, 20 steps) | ◐ button, 30 steps |
| 4.9 | One drag is one undo step | ✔ | ✔ | ✔ |
| 4.10 | Redo | P2 (in the reducer only) | P2 (in the reducer only) | P2 |
| 4.11 | Duplicate, copy/paste, repeat-down, multi-select, align, snap | P2 | P2 | P2 |

## 5. Field settings (inspector)
The settings shown are the catalog's `fieldSettingsOf(type)` intersected with the host's capabilities.

| # | Behaviour | sign-web | Console | Mobile |
|---|---|---|---|---|
| 5.1 | Reassign the field to another recipient or role | ✔ | ✔ | ✔ |
| 5.2 | Required toggle (check-box groups share it) | ✔ | ✔ | ✔ |
| 5.3 | Name: "comes from profile / signer types it" (`name_mode`) | ✔ | ✗ hidden until P1-3 (capability flag) | ✔ |
| 5.4 | Check box label, group, rule (any / one), minimum; group consistency rules | ✔ | ✗ hidden until P1-3 (capability flag) | ✔ |
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

## Mobile follow-ups (not in P1-5)
These rows are where mobile differs from the web editor:
- 2.2 / 3.3 — in-view placement.
- 4.4 — nudge step (4pt on mobile, 2pt on web).
- 4.8 — undo depth (30 on mobile, 20 on web).
- 6.1 — autosave.

Aligning them is a mobile change. Per §8 item 5 it is tracked against this checklist; it is not built here.
