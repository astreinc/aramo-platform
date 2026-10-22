import { type Session } from '@aramo/fe-foundation';
import { RtrDraftEditor, RtrTemplateDetail } from '@aramo/document-templates-web';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { AramoDefaultPreview } from './AramoDefaultPreview';
import { CreateOwnTemplate } from './CreateOwnTemplate';
import { OurTemplatesPage } from './OurTemplatesPage';
import { TemplateGalleryPage } from './TemplateGalleryPage';

// DOC-TEMPLATE-LIB-1 T-4 (§8.2) — the Org Home "Document templates" sub-tree, mounted at
// /org/document-templates/*. The detail, draft editor and approval (preview gate →
// approve) are the shared screens from @aramo/document-templates-web, routed by template
// id; their navigation targets default to these Org Home paths.
//   /org/document-templates                       Our templates (ORG-UX-1 §3, P6)
//   /org/document-templates/gallery               Template gallery (ORG-UX-1 §3, P6)
//   /org/document-templates/new                   create your own (blank)
//   /org/document-templates/aramo/:templateId     an Aramo gallery default, branded preview
//   /org/document-templates/:templateId           your template: versions, approve, new draft
//   /org/document-templates/:templateId/draft     the draft editor
// The Org Home session is passed down explicitly (the screens' scope checks are UX; the
// server is the boundary).
function DetailRoute({ session }: { readonly session: Session }) {
  const { templateId } = useParams();
  return templateId === undefined ? <Navigate to="/org/document-templates" replace /> : <RtrTemplateDetail templateId={templateId} sessionOverride={session} />;
}

function DraftRoute({ session }: { readonly session: Session }) {
  const { templateId } = useParams();
  return templateId === undefined ? <Navigate to="/org/document-templates" replace /> : <RtrDraftEditor templateId={templateId} sessionOverride={session} />;
}

function DefaultRoute() {
  const { templateId } = useParams();
  return templateId === undefined ? <Navigate to="/org/document-templates" replace /> : <AramoDefaultPreview templateId={templateId} />;
}

export function DocumentTemplatesRoutes({ session }: { readonly session: Session }) {
  return (
    <Routes>
      <Route index element={<OurTemplatesPage session={session} />} />
      <Route path="gallery" element={<TemplateGalleryPage session={session} />} />
      <Route path="new" element={<CreateOwnTemplate sessionOverride={session} />} />
      <Route path="aramo/:templateId" element={<DefaultRoute />} />
      <Route path=":templateId" element={<DetailRoute session={session} />} />
      <Route path=":templateId/draft" element={<DraftRoute session={session} />} />
    </Routes>
  );
}
