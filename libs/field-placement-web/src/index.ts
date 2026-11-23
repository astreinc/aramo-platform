// @aramo/field-placement-web — the ONE web placement editor (Aramo-Sign-Field-Placement-
// Enterprise-Parity-Directive-v1_0-LOCKED §4 P1-5, ruling R-8), used by sign-web Prepare
// (an envelope's recipients) and the console's fixed-form Studio (a template's signer roles).
// scope:shared: imports only React and @aramo/sign-fields (the one field catalog), so both
// scope:sign and scope:platform may use it. Hosts keep their own chrome and API calls.
export { PlacementEditor, DEFAULT_PLACEMENT_COPY, type PlacementEditorProps, type PlacementCopy } from './PlacementEditor';
export { PlacementPages, pageSlotsOf, defaultFace, type PlacementPagesProps, type PageRenderer, type PageSlot, type FieldFace, type ConditionLink } from './PlacementPages';
export {
  DEFAULT_SETTINGS,
  GROUPED_TYPES,
  NEW_DROPDOWN_CHOICES,
  isGroupedType,
  groupKeysOf,
  freeGroupKey,
  defaultSettingsFor,
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
// FIELD-PARITY-1 P3 §6.2 — the settings ↔ wire members and the ONE settings rule's refusal.
export {
  settingsFromWire,
  settingsToWire,
  settingsIssue,
  conditionIssues,
  conditionRows,
  optionsToWire,
  cleanChoices,
  nextRadioLabel,
  radioOptionBelow,
  RADIO_OPTION_GAP,
  type WireSettings,
  type SettingsToWireOptions,
} from './lib/settings-wire';
export { FieldSettingsPanel, VALIDATION_LABELS, describeField, type FieldSettingsPanelProps } from './FieldSettingsPanel';
// FIELD-PARITY-2 B-7 — authoring "Show only when…" (pure; the shared rules underneath).
export {
  TRIGGER_TYPES,
  CONDITION_WHEN_LABELS,
  conditionWhensFor,
  triggerChoices,
  defaultConditionFor,
  usableTriggers,
  dependentsOf,
  staleConditionIds,
  clearStaleConditions,
  remapConditions,
  previewShownIds,
  setPreviewAnswer,
} from './lib/conditions';
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
  // P2 (§5 P2-1..P2-3) — many-field commands.
  placeFields,
  assignFields,
  alignFields,
  distributeFields,
  sameSizeFields,
  type PageGuides,
  type Command,
  type CommandContext,
  type DragPrecision,
  type EditorAction,
  type EditorState,
  type FieldChange,
  type HistoryEntry,
} from './lib/editor-state';
export {
  NUDGE_STEP,
  NUDGE_STEP_LARGE,
  KEYMAP,
  fieldKeyIntent,
  editorKeyIntent,
  isUndoKey,
  isRedoKey,
  isTextControl,
  type KeyLike,
  type FieldKeyIntent,
  type EditorKeyIntent,
} from './lib/keymap';
// P2 (§5 P2-1..P2-3) — arrange / snap geometry and the copy builders (pure).
export {
  GRID_STEP,
  SNAP_DISTANCE_PX,
  boundsOf,
  rectFromPoints,
  intersects,
  alignBoxes,
  distributeBoxes,
  sameSizeBoxes,
  snapMove,
  snapResize,
  clampGroupDelta,
  type AlignEdge,
  type Axis,
  type Dimension,
  type SnapOptions,
  type SnapResult,
  type GuideLines,
} from './lib/arrange';
export { DUPLICATE_OFFSET, REPEAT_MAX, REPEAT_DEFAULT_GAP, cloneFields, repeatDown, repeatPitchOf, nextGroupKey, copyable, type CloneContext, type RepeatResult } from './lib/clone';
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
// P2-4 (§5) — suggestions: the host maps the detector's answer; the editor shows ghosts.
export { suggestionsFromWire, pendingGhosts, fieldsFromSuggestions, acceptSuggestions, type PlacementSuggestion, type WireSuggestion } from './lib/suggestions';
// P2-5 / P2-6 (§5) — the opt-in upload options and the import result, for every web upload.
export { UploadFieldOptions, FieldImportResult, uploadFlags, NO_UPLOAD_FIELD_OPTIONS, type UploadFieldOptionsValue, type FieldImportResultValue } from './UploadFieldOptions';
