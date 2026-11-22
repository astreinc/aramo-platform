// @aramo/field-placement-web — the ONE web placement editor (Aramo-Sign-Field-Placement-
// Enterprise-Parity-Directive-v1_0-LOCKED §4 P1-5, ruling R-8), used by sign-web Prepare
// (an envelope's recipients) and the console's fixed-form Studio (a template's signer roles).
// scope:shared: imports only React and @aramo/sign-fields (the one field catalog), so both
// scope:sign and scope:platform may use it. Hosts keep their own chrome and API calls.
export { PlacementEditor, DEFAULT_PLACEMENT_COPY, type PlacementEditorProps, type PlacementCopy } from './PlacementEditor';
export { PlacementPages, pageSlotsOf, defaultFace, type PlacementPagesProps, type PageRenderer, type PageSlot, type FieldFace } from './PlacementPages';
export {
  DEFAULT_SETTINGS,
  editableSettingsOf,
  paletteFor,
  typeLabelOf,
  type NameMode,
  type GroupRule,
  type PlacementSettings,
  type PlacedField,
  type PlacementDocument,
  type PlacementAssignee,
  type PlacementPrefill,
  type PlacementCapabilities,
  type PageRef,
  type PaletteEntry,
  type PaletteOptions,
} from './lib/model';
export { applySettings, groupSize, type SettingsPatch, type ConfigurableField } from './lib/settings';
export {
  HISTORY_LIMIT,
  editorReducer,
  initialEditorState,
  diffFields,
  applyChanges,
  roundGestureBox,
  placeField,
  removeFields,
  nudgeFields,
  resizeFields,
  assignField,
  configureField,
  type Command,
  type CommandContext,
  type DragPrecision,
  type EditorAction,
  type EditorState,
  type FieldChange,
  type HistoryEntry,
} from './lib/editor-state';
export { NUDGE_STEP, NUDGE_STEP_LARGE, fieldKeyIntent, isUndoKey, isTextControl, type KeyLike, type FieldKeyIntent } from './lib/keymap';
export { AUTOSAVE_DELAY_MS, useAutosave, type Autosave, type AutosaveOptions, type SaveState } from './lib/useAutosave';
// The editor geometry (moved from @aramo/document-templates-web/pdf, which re-exports it).
export { clampBox, toPdf, toTopLeft, type Box, type PdfPageInfo } from './lib/geometry';
// P0-1 viewport helpers (moved from libs/document-templates-web fixed-form-viewport.ts).
export {
  intersectRects,
  visibleArea,
  pickTargetPage,
  visibleRegionInPage,
  placeNewField,
  NEW_FIELD_INSET,
  NEW_FIELD_CASCADE_STEP,
  NEW_FIELD_CASCADE_CYCLE,
  NEW_FIELD_FALLBACK_TOP,
  type ScreenRect,
  type PageRegion,
  type PageSize,
} from './lib/viewport';
