# Backlog — Aramo Sign app (Android + iOS): fast placement tools

**Type:** Backlog (scope question, then a directive if built). Not a defect of the current build.
**Raised by:** PO (Purush), 2026-11-24, from the Android field test "faster placement tools" (Failed).
**Needs:** a Lead / PO ruling on scope (below) before any recon or directive.

---

## What the field test found

The test ran the fast placement tools on the Send flow's field placement screen in the Android
app. None of them were there except Undo. iOS is the same: both apps are built from one React
Native code base (`mobile/sign`), and the placement editor has no platform-specific code
(`mobile/sign/src/features/editor/FieldEditor.tsx`; the only platform branch is a font in
`FieldBox.tsx:75`).

| Tool | Web (Sign Prepare + console Studio) | Android / iOS app |
|---|---|---|
| Duplicate, copy / paste | Yes (FIELD-PARITY-1 P2-1) | No |
| Repeat down (N copies at a set spacing) | Yes (P2-1) | No |
| Multi-select (shift-click, drag a box) | Yes (P2-2) | No (one field at a time) |
| Align / distribute / same size | Yes (P2-2) | No |
| Snap to field edges and grid, guides | Yes (P2-3) | No |
| Undo | Yes | Yes (`FieldEditor.tsx:655`) |
| Redo | Yes (P2-3) | No |
| Save and reopen a draft | Yes (Save draft) | Yes, automatic: Send drafts sync; reopen from Drafts (no Save draft button) |

## Why it is a scope question

`Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED` (FIELD-PARITY-1):

- **P2-1 to P2-3** are written in keyboard and mouse terms (Cmd/Ctrl+D, shift-click,
  drag-a-box, "Shift disables snap") and, unlike P2-4 (suggestions: "sign-web Prepare,
  mobile Prepare and the console Studio"), do not name the app. They were delivered in the
  shared web placement editor (`libs/field-placement-web`).
- **P1-5** says the app "consumes the same catalog, rules, keyboard-free equivalents and
  default sizes, and must pass the same behaviour-parity checklist (§8)". Read broadly, that
  asks for touch equivalents of P2-1 to P2-3 in the app.

So either:

- **(a)** P1-5 covers them: a gap in a LOCKED program, to be closed; or
- **(b)** it does not: a new app feature, and the field test is **web only** until one ships.

Under the scope freeze this needs an explicit ruling.

## Suggested shape if built (for the recon to confirm)

A phone-sized set, not a copy of the web toolset:

1. **Duplicate** and **Repeat down** as buttons on a selected field (same rules as web:
   `libs/field-placement-web/src/lib/clone.ts` — group keys per row, conditions follow the
   copy, rows that do not fit are skipped and reported).
2. **Redo** beside Undo (the app reducer already keeps history: `editorReducer.ts`).
3. **Snap** to nearby field edges while dragging (the web snap rule, as pure shared code).
4. **Multi-select and Align** later: they need a touch selection design first (long-press to
   add to a selection, or a selection mode).

Per the "one rule, one place" principle, any geometry rule the app needs (repeat spacing,
snap distance, align) should move to a shared pure-TS library both editors import, rather
than a second copy in the app.

## Meanwhile (test plan)

- Mark the field test "faster placement tools" **web only**.
- On Android / iOS, test only **Undo** and **draft reopen** (leave the envelope, reopen it
  from Drafts, check every field is where it was).
