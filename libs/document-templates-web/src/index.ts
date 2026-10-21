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
