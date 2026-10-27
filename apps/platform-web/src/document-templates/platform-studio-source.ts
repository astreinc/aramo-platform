import { hasScope, type Session } from '@aramo/fe-foundation';
import { PLATFORM_STUDIO_COPY, type TemplateStudioDataSource } from '@aramo/document-templates-web';

import { DOC_TEMPLATE_MANAGE_SCOPE, documentTemplatesApi } from './document-templates-api';

// TEMPLATE-STUDIO-1 S-0 (directive §2) — the PLATFORM data source of the shared Template
// Studio (libs/document-templates-web): the Aramo defaults at /platform/document-templates*
// and the variable catalog at /platform/template-variables, through the platform API
// client. `:manage` edits, publishes, withdraws and edits properties (PLATFORM-UX-1 F-9);
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
    createDraft: (id, body) => documentTemplatesApi.createDraft(id, body),
    saveDraft: (versionId, body) => documentTemplatesApi.updateDraft(versionId, body),
    preview: (versionId) => documentTemplatesApi.preview(versionId),
    approve: (versionId) => documentTemplatesApi.publish(versionId),
    updateProperties: (id, patch) => documentTemplatesApi.updateTemplate(id, patch),
    withdraw: (id, body) => documentTemplatesApi.withdraw(id, body),
    cancelWithdrawal: (id) => documentTemplatesApi.cancelWithdrawal(id),
    capabilities: { canEdit: canManage, canApprove: canManage, canWithdraw: canManage, productTags: true, description: true },
    copy: PLATFORM_STUDIO_COPY,
  };
}
