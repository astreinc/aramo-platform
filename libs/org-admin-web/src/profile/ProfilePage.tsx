import type { ProductAvailabilityView, Session } from '@aramo/fe-foundation';

import { OrgPageHeader } from '../ui/OrgPage';

// ORG-UX-1 — placeholder; implemented in this increment (I-7).
export function ProfilePage(_props: { readonly session?: Session; readonly products?: ProductAvailabilityView | null }) {
  return <OrgPageHeader section="profile" />;
}
