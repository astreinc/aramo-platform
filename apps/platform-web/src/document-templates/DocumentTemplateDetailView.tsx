import { useParams } from 'react-router-dom';
import type { Session } from '@aramo/fe-foundation';

import { TemplateStudio } from './studio/TemplateStudio';

// PLATFORM-UX-1 F-9 (directive R-12) — /document-templates/:id. The Template Studio
// REPLACES the former detail view at the same path; the route and this export keep
// their names so App.tsx is unchanged. Keyed by id so moving between templates starts a
// fresh Studio (no draft state leaks across templates).
export function DocumentTemplateDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams<{ id: string }>();
  return <TemplateStudio key={id} session={session} templateId={id} />;
}
