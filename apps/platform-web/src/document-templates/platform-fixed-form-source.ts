import { hasScope, type Session } from '@aramo/fe-foundation';
import { isTemplateProductKey, type FixedFormStudioDataSource } from '@aramo/document-templates-web';

import { DOC_TEMPLATE_MANAGE_SCOPE, documentTemplatesApi } from './document-templates-api';
import { fixedFormsApi } from './fixed-forms-api';

// TEMPLATE-PRODUCT-1 §7.2 — the platform data source of the Studio's fixed-form mode: the
// fixed-form routes plus the shared default routes (publish, discard draft, tags, withdraw).
// `:manage` edits; `:read` sees the form read-only.
export function platformFixedFormDataSource(session: Session): FixedFormStudioDataSource {
  const canManage = hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  return {
    loadTemplate: (id) => documentTemplatesApi.getTemplate(id),
    typeProducts: async (typeId) => {
      const t = (await documentTemplatesApi.listDocumentTypes()).document_types.find((d) => d.id === typeId);
      return (t?.products ?? []).filter(isTemplateProductKey);
    },
    view: (versionId) => fixedFormsApi.view(versionId),
    pdf: (versionId) => fixedFormsApi.pdf(versionId),
    createDraft: (templateId) => fixedFormsApi.createDraft(templateId),
    uploadPdf: (versionId, b64) => fixedFormsApi.uploadPdf(versionId, b64),
    saveLayout: (versionId, body) => fixedFormsApi.saveLayout(versionId, body),
    preview: (versionId) => fixedFormsApi.preview(versionId),
    publish: (versionId) => documentTemplatesApi.publish(versionId),
    ...(canManage
      ? {
          discardDraft: (versionId: string) => documentTemplatesApi.discardDraft(versionId),
          updateProducts: (id: string, products: readonly string[]) => documentTemplatesApi.updateTemplate(id, { products: [...products] }),
          withdraw: (id: string, body: { notice_days: number; reason: string | null }) => documentTemplatesApi.withdraw(id, body),
        }
      : {}),
  };
}
