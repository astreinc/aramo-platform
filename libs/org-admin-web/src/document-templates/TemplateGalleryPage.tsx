import type { Session } from '@aramo/fe-foundation';

import { OrgPageHeader } from '../ui/OrgPage';

// ORG-UX-1 — placeholder; implemented in this increment (I-7).
export function TemplateGalleryPage(_props: { readonly session: Session }) {
  return <OrgPageHeader section="gallery" />;
}
