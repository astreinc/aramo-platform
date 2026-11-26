import { hasScope, type Session } from '@aramo/fe-foundation';
import { PLATFORM_STUDIO_COPY, type TemplateStudioDataSource } from '@aramo/document-templates-web';

import { DOC_TEMPLATE_MANAGE_SCOPE, documentTemplatesApi } from './document-templates-api';

// TEMPLATE-STUDIO-1 S-0 (directive §2) — the PLATFORM data source of the shared Template
// Studio (libs/document-templates-web): the Aramo defaults at /platform/document-templates*
// and the variable catalog at /platform/template-variables, through the platform API
// client. `:manage` edits, publishes, withdraws, discards drafts, deletes never-published
// defaults (TEMPLATE-PRODUCT-1 §3) and edits properties (PLATFORM-UX-1 F-9);
// `:read` sees the published version in Preview only (R-13). Content keeps the default
// codec (no letterhead on platform defaults).
export function platformStudioDataSource(session: Session): TemplateStudioDataSource {
  const canManage = hasScope(session, DOC_TEMPLATE_MANAGE_SCOPE);
  return {
    load: (id) => documentTemplatesApi.getTemplate(id),
    catalog: async (id) => {
      const [b, vars, types] = await Promise.all([
        documentTemplatesApi.allowedBindings(id),
        documentTemplatesApi.listVariables().catch(() => ({ variables: [] })),
        documentTemplatesApi.listDocumentTypes().catch(() => ({ document_types: [] })),
      ]);
      return { variables: vars.variables, bindings: b.bindings, documentTypes: types.document_types };
    },
    // TEMPLATE-FIELDS-1 F-14 — a first save with fields in the text opens the draft, then saves
    // the content and its field rows together (the create route takes content only).
    createDraft: async (id, body) => {
      if (body.fields === undefined || body.fields.length === 0) {
        const { fields: _none, ...content } = body;
        void _none;
        return documentTemplatesApi.createDraft(id, content);
      }
      const opened = await documentTemplatesApi.createDraft(id);
      return documentTemplatesApi.updateDraft(opened.id, body);
    },
    saveDraft: (versionId, body) => documentTemplatesApi.updateDraft(versionId, body),
    fields: (versionId) => documentTemplatesApi.listVersionFields(versionId),
    preview: (versionId) => documentTemplatesApi.preview(versionId),
    approve: (versionId) => documentTemplatesApi.publish(versionId),
    // TEMPLATE-PRODUCT-1 §3.4 — discard a draft / delete a never-published default (:manage).
    ...(canManage
      ? {
          discardDraft: (versionId: string) => documentTemplatesApi.discardDraft(versionId),
          // TEMPLATE-IMPORT-1 W-9 — import a Word file as the draft.
          importWord: (id: string, file: { filename: string; content_base64: string }) => documentTemplatesApi.importWord(id, file),
          deleteTemplate: (id: string) => documentTemplatesApi.deleteTemplate(id),
        }
      : {}),
    updateProperties: (id, patch) => documentTemplatesApi.updateTemplate(id, patch),
    withdraw: (id, body) => documentTemplatesApi.withdraw(id, body),
    cancelWithdrawal: (id) => documentTemplatesApi.cancelWithdrawal(id),
    capabilities: { canEdit: canManage, canApprove: canManage, canWithdraw: canManage, productTags: true, description: true, inlineFields: 'edit' },
    copy: PLATFORM_STUDIO_COPY,
  };
}
