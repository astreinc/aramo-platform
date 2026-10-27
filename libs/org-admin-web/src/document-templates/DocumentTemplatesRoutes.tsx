import { type Session } from '@aramo/fe-foundation';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { AramoDefaultStudio } from './AramoDefaultStudio';
import { CreateOwnTemplate } from './CreateOwnTemplate';
import { OrgTemplateStudio } from './OrgTemplateStudio';
import { OurTemplatesPage } from './OurTemplatesPage';
import { TemplateGalleryPage } from './TemplateGalleryPage';

// DOC-TEMPLATE-LIB-1 T-4 (§8.2) — the Org Home "Document templates" sub-tree, mounted at
// /org/document-templates/*. ORG-UX-1 §3 paths are kept (the handoff's /org/templates*
// paths are not adopted).
//   /org/document-templates                       Our templates (ORG-UX-1 §3, P6)
//   /org/document-templates/gallery               Template gallery (ORG-UX-1 §3, P6)
//   /org/document-templates/new                   create your own (blank) → opens the Studio
//   /org/document-templates/aramo/:templateId     TEMPLATE-STUDIO-1 S-2: an Aramo gallery default in
//                                                 the shared Studio, read only (Preview, tenant
//                                                 branding) + Adopt (Conforming Amendment #3)
//   /org/document-templates/:templateId           TEMPLATE-STUDIO-1 S-1: your template in the
//                                                 shared Template Studio (replaces the former
//                                                 detail screen and the draft editor)
//   /org/document-templates/:templateId/draft     → redirects to :templateId (Conforming
//                                                 Amendment #3)
// The Org Home session is passed down explicitly (the screens' scope checks are UX; the
// server is the boundary).
function StudioRoute({ session, organizationHref, admin }: { readonly session: Session; readonly organizationHref: string | null; readonly admin: boolean }) {
  const { templateId } = useParams();
  return templateId === undefined ? (
    <Navigate to="/org/document-templates" replace />
  ) : (
    <OrgTemplateStudio session={session} templateId={templateId} organizationHref={organizationHref} admin={admin} />
  );
}

function DraftRedirect() {
  const { templateId } = useParams();
  return <Navigate to={templateId === undefined ? '/org/document-templates' : `/org/document-templates/${encodeURIComponent(templateId)}`} replace />;
}

function DefaultRoute({ session, organizationHref, admin }: { readonly session: Session; readonly organizationHref: string | null; readonly admin: boolean }) {
  const { templateId } = useParams();
  return templateId === undefined ? (
    <Navigate to="/org/document-templates" replace />
  ) : (
    <AramoDefaultStudio session={session} templateId={templateId} organizationHref={organizationHref} admin={admin} />
  );
}

export function DocumentTemplatesRoutes({
  session,
  organizationHref = null,
  admin = false,
}: {
  readonly session: Session;
  /** The Organization crumb's link (org admins); null for template authors. */
  readonly organizationHref?: string | null;
  /** Organization administrator (the Studio account menu's badge). */
  readonly admin?: boolean;
}) {
  return (
    <Routes>
      <Route index element={<OurTemplatesPage session={session} />} />
      <Route path="gallery" element={<TemplateGalleryPage session={session} />} />
      <Route path="new" element={<CreateOwnTemplate sessionOverride={session} />} />
      <Route path="aramo/:templateId" element={<DefaultRoute session={session} organizationHref={organizationHref} admin={admin} />} />
      <Route path=":templateId" element={<StudioRoute session={session} organizationHref={organizationHref} admin={admin} />} />
      <Route path=":templateId/draft" element={<DraftRedirect />} />
    </Routes>
  );
}
