// libs/document-templates-web — the shared document-template UI (DOC-TEMPLATE-LIB-1 T-4,
// Implementation Directive v1.0 LOCKED §8.3). Moved out of apps/ats-web/src/settings/
// documents/: the safe HTML renderer (dt-html-render), the template UI kit (dt-ui), the
// block editor, the preview / approve / discard modals, the tenant template detail and the
// draft editor, and the /v1/document-templates client. Consumed by libs/org-admin-web (the
// Org Home "Document templates" section — the one tenant administration surface, ADR-0034
// D11) and apps/ats-web (the Send RTR modal renders the governed template with SafeDoc).
// Depends only on @aramo/fe-foundation (scope:shared) — no product lib.
export { SafeDoc, Letterhead, type LetterheadInfo } from './dt-html-render';
export {
  bindingMapFrom,
  emptyBindingMap,
  fmtDate,
  DocIcon,
  DocIconSmall,
  LockIcon,
  CheckIcon,
  PlusIcon,
  EyeIcon,
  type BindingMap,
} from './dt-ui';
export {
  PreviewModal,
  PreviewPaper,
  SampleValues,
  previewContentFrom,
  contentFromVersion,
  htmlOf,
  type PreviewContent,
} from './dt-modals';
export { RtrTemplateDetail } from './RtrTemplateDetail';
export { RtrDraftEditor } from './RtrDraftEditor';
export {
  DocTemplateRoutesProvider,
  useDocTemplateRoutes,
  ORG_DOC_TEMPLATE_ROUTES,
  type DocTemplateRoutes,
} from './dt-routes';
export {
  DOC_TEMPLATE_READ_SCOPE,
  DOC_TEMPLATE_MANAGE_SCOPE,
  DOC_TEMPLATE_AUTHOR_SCOPE,
  canAuthorTemplates,
  canApproveTemplates,
  canReadTemplates,
  adoptTemplate,
  RIGHT_TO_REPRESENT_TYPE_ID,
  RTR_HTML_SCHEMA_V1,
  RTR_GENERATED_SCHEMA_V1,
  listDocumentTemplates,
  getDocumentTemplate,
  listTemplateVersions,
  getTemplateVersion,
  fetchTemplateCatalog,
  activateTemplateVersion,
  previewTemplateVersion,
  resolveUserNames,
  fetchTemplateLibrary,
  previewTemplateDefault,
  listTemplateSelections,
  setTemplateSelection,
  clearTemplateSelection,
  createOwnTemplate,
  type DocumentTemplateView,
  type TemplateVersionView,
  type TemplateSamplePreview,
  type TemplateBinding,
  type TemplateCatalog,
  type TemplateStatus,
  type TemplateLibraryItem,
  type TemplateLibraryView,
  type TemplateDocumentType,
  type TemplateDefaultPreview,
  type TemplateSelectionView,
  type TemplateOwnerScope,
} from './document-templates-api';
// PLATFORM-UX-1 F-9 (directive R-11) — the Template Studio codec (additive: built on the
// rtr-html-v1 contract and HTML_CODEC above; no existing export changes).
export {
  studioBlocksFromHtml,
  studioBlocksToHtml,
  // TEMPLATE-STUDIO-1 B-1 — the letterhead-preserving document codec (additive).
  STUDIO_LETTERHEAD_KIND,
  STUDIO_LETTERHEAD_HTML,
  isStudioLetterheadBlock,
  studioDocFromHtml,
  studioDocToHtml,
  studioContentBlocks,
  studioDocHasLetterhead,
  studioLetterheadState,
  type StudioLetterheadBlock,
  type StudioDocBlock,
  type StudioLetterheadState,
  isCanonicalStudioHtml,
  studioPlainText,
  studioVariableKeys,
  isStudioValueEmpty,
  removeStudioVariable,
  appendStudioVariable,
  convertStudioValue,
  studioValueFromText,
  studioPreviewParts,
  makeStudioChip,
  renderStudioBlockDom,
  studioPasteNodes,
  createStudioCodec,
  serializeStudioBlockDom,
  studioActiveMarks,
  studioToggleMark,
  studioInsertAtRange,
  variableToken,
  type StudioBlock,
  type StudioBlockKind,
  type StudioCodec,
  type StudioChipState,
  type StudioChipInfo,
  type StudioChipResolver,
} from './studio-codec';
// TEMPLATE-STUDIO-1 S-0 (directive §2) — the ONE shared Template Studio (moved from
// apps/platform-web), its data-source adapter, the content codecs and the platform copy
// table (additive: no existing export changes).
export { TemplateStudio, type TemplateStudioProps, type StudioAccountSlot } from './studio/TemplateStudio';
export {
  DEFAULT_STUDIO_CONTENT_CODEC,
  LETTERHEAD_STUDIO_CONTENT_CODEC,
  STUDIO_HTML_CONTENT_VERSION,
  type TemplateStudioDataSource,
  type TemplateStudioContext,
  type TemplateStudioCopy,
  type StudioCapabilities,
  type StudioContentCodec,
  type StudioContentBody,
  type StudioCatalogData,
  type StudioCatalogVariable,
  type StudioAllowedBinding,
  type StudioSamplePreview,
  type StudioTemplate,
  type StudioTemplateInfo,
  type StudioVersion,
  type StudioVersionStatus,
  type StudioPropertiesPatch,
  type StudioCrumb,
} from './studio/data-source';
export { PLATFORM_STUDIO_COPY } from './studio/studio-copy';
// TEMPLATE-STUDIO-1 S-1 (directive §3) — the organization context: the tenant template
// data source, its copy table and the static Sections set (additive).
export {
  organizationStudioCopy,
  organizationReadinessLabel,
  ORGANIZATION_APPROVE_CONSEQUENCE,
  ORGANIZATION_SCOPE_CARD,
  ORGANIZATION_VARIABLES_NOTE,
  type OrganizationStudioCopyOptions,
} from './studio/studio-copy';
export {
  organizationStudioDataSource,
  ORGANIZATION_STUDIO_SECTIONS,
  ORGANIZATION_STUDIO_API,
  type OrganizationStudioApi,
  type OrganizationStudioSourceOptions,
} from './studio/organization-source';
export { LETTERHEAD_SAVE_BLOCKED } from './studio/TemplateStudio';
export type { StudioSection, StudioLetterheadApi } from './studio/data-source';
