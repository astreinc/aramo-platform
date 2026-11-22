// @aramo/sign-fields — the ONE field catalog (Aramo-Sign-Field-Placement-Enterprise-Parity-
// Directive-v1_0-LOCKED §4 P1-1, ruling R-4).
//
// scope:shared, so the console (scope:platform), Sign (scope:sign), the documents libraries
// (scope:boundary) and mobile/sign can all import it; also type:client-shared, so
// libs/sign-client may import it and re-export it. Pure TypeScript ESM: no React, no React
// Native, no DOM, no `node:*`, no npm dependency. Relative imports carry the `.js` suffix (the
// repo's nodenext rule); mobile/sign resolves them to `.ts` through metro.config.js and
// jest.resolver.js.

export {
  FIELD_SURFACES,
  WHEN_PAYMENTS_AVAILABLE,
  FIELD_CATALOG,
  FIELD_TYPE_KEYS,
  FIELD_DEFAULTS,
  PROFILE_TEXT_FIELD_TYPES,
  fieldTypesFor,
  isFieldTypeOn,
  isFieldTypeKey,
  isPaymentsGatedOn,
  fieldSettingsOf,
  TEMPLATE_TYPE_MAPPING,
  RETIRED_FIELD_TYPES,
  isCircleMark,
  type FieldSurface,
  type SurfaceRule,
  type FieldSurfaceRules,
  type FieldValueKind,
  type FieldFiller,
  type FieldSetting,
  type FieldCatalogEntry,
  type FieldTypeKey,
  type FieldTypeOn,
  type FieldTypeOnWhenAvailable,
  type SurfaceGate,
  type FieldDefaults,
  type ProfileTextFieldType,
} from './lib/catalog.js';

// FIELD-PARITY-1 P1-3 — the settings a template field carries (Sign's M-A6 §2 settings).
export {
  TEMPLATE_FIELD_SETTINGS,
  SIGNER_NAME_MODES,
  DEFAULT_SIGNER_NAME_MODE,
  CHECKBOX_GROUP_RULES,
  DEFAULT_CHECKBOX_GROUP_RULE,
  FIELD_LABEL_MAX,
  FIELD_GROUP_KEY_MAX,
  NO_TEMPLATE_FIELD_SETTINGS,
  RADIO_GROUP_RULE,
  FIELD_VALIDATIONS,
  VALIDATIONS_BY_TYPE,
  OPTION_KEYS_BY_TYPE,
  NUMBER_FORMATS,
  DEFAULT_MONEY_CURRENCY,
  DEFAULT_MONEY_DECIMALS,
  FIELD_TOOLTIP_MAX,
  FIELD_PLACEHOLDER_MAX,
  FIELD_FONT_SIZE_MIN,
  FIELD_FONT_SIZE_MAX,
  FIELD_DATA_NAME_PATTERN,
  DROPDOWN_CHOICES_MAX,
  DROPDOWN_CHOICE_VALUE_MAX,
  DROPDOWN_CHOICE_LABEL_MAX,
  NUMBER_DECIMALS_MAX,
  MULTILINE_TEXT_MAX,
  ISO_DATE_PATTERN,
  FIELD_SETTING_REFUSAL_REASONS,
  templateSettingsOf,
  parseTemplateFieldSettings,
  parseFieldSettings,
  senderFilledFieldsEnabled,
  isIsoDate,
  checkboxGroupIssues,
  templateNameModeOf,
  setFieldSettings,
  type FieldSettings,
  type FieldSettingsParseOptions,
  type FieldSettingRefusalReason,
  type FieldValidation,
  type FieldOptions,
  type DropdownChoice,
  type NumberFormat,
  type TemplateFieldSetting,
  type SignerNameModeSetting,
  type CheckboxGroupRuleSetting,
  type TemplateFieldSettings,
  type FieldSettingRefusal,
  type TemplateFieldSettingsParse,
  type GroupedTemplateField,
  type CheckboxGroupIssue,
} from './lib/field-settings.js';

// FIELD-PARITY-1 P3 §6 — the value rules (signer fill, sender-filled values) and how a value
// prints on the executed PDF and the certificate.
export {
  FIELD_VALUE_REFUSAL_REASONS,
  fieldValueRefusal,
  hasFieldValue,
  formatChosenDate,
  formatNumberValue,
  fieldValueDisplay,
  type FieldValueRefusalReason,
  type FieldValueRuleField,
  type FieldDateFormat,
} from './lib/field-values.js';

// FIELD-PARITY-1 P2-5 / P2-6 — fillable-PDF import and text tags: the rules that turn a PDF's
// form fields and {{…}} tags into catalog fields (the PDF work is @aramo/documents-rendering).
export {
  IMPORT_MIN_FIELD_SIZE,
  FIELD_IMPORT_WARNING_CODES,
  TEXT_TAG_COVER_PAD,
  PDF_FORM_FIELD_KINDS,
  PDF_FORM_FIELD_MAPPING,
  TEXT_TAG_TYPE_ALIASES,
  TEXT_TAG_UNSUPPORTED_TYPES,
  TEXT_TAG_PATTERN,
  fitImportBox,
  importFieldKey,
  importGroupKey,
  planPdfFormFields,
  textTagTypeOf,
  parseTextTag,
  findTextTags,
  tagBoxToPdf,
  tagFieldRect,
  tagCoverRect,
  planTextTags,
  matchTagRole,
  type ImportedField,
  type FieldImportWarning,
  type FieldImportWarningCode,
  type PageSize,
  type FieldBox,
  type PdfFormFieldKind,
  type PdfFormWidget,
  type FieldImportPlan,
  type ParsedTextTag,
  type TextTagParse,
  type TagWord,
  type FoundTextTag,
  type TagPageFrame,
  type TagTextPage,
  type TextTagPlan,
} from './lib/field-import.js';

// FIELD-PARITY-1 P2-4 — the deterministic field detector (labels, underscore lines, empty boxes
// and table cells, checkbox glyphs) and the editors' pending-suggestion rule; the M-A14
// signature-block mode moved here from apps/sign-service unchanged.
export {
  SUGGESTION_LIMIT,
  DETECT_LIMIT,
  SUGGESTED_SIZE,
  DETECT_MIN_SIZE,
  suggestSignatureBlock,
  detectFields,
  pendingSuggestions,
  suggestionReasonText,
  isSuggestedFieldType,
  type DetectWord,
  type DetectTextPage,
  type DetectRect,
  type DetectGraphicsPage,
  type DetectPageFrame,
  type SuggestedFieldType,
  type SignatureBlockFieldType,
  type SignatureBlockSuggestion,
  type DetectReason,
  type DetectedField,
  type SkippedPage,
  type DetectResult,
  type DetectOptions,
  type PendingSuggestionLike,
  type PlacedBoxLike,
} from './lib/field-detect.js';

// FIELD-PARITY-1 P2-5 / P2-6 — the upload options' copy, warning copy and text-tag help (one
// place for every UI).
export {
  UPLOAD_OPTION_COPY,
  FIELD_IMPORT_WARNING_COPY,
  TEXT_TAG_HELP,
  fieldImportWarningText,
  fieldImportSummary,
  isFieldImportWarningCode,
} from './lib/field-import-copy.js';
