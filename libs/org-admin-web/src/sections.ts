// The Organization administration sections, in the accepted order (frozen App
// Home prototype, 2026-10-18): one registry for the tab row and the App Home
// admin tiles, so the two can never disagree.
export interface OrgSection {
  readonly key: 'profile' | 'users' | 'roles' | 'sites' | 'domain' | 'settings' | 'audit';
  readonly label: string;
  readonly sub: string;
}

export const ORG_SECTIONS: readonly OrgSection[] = [
  { key: 'profile', label: 'Profile', sub: 'Name, legal details, logo' },
  { key: 'users', label: 'Users & invitations', sub: 'People and their app roles' },
  { key: 'roles', label: 'Users & product access', sub: 'Who can use which app, and with which role' },
  { key: 'sites', label: 'Sites', sub: 'Offices and locations' },
  { key: 'domain', label: 'Domain', sub: 'Domain verification and sign-in' },
  { key: 'settings', label: 'Settings', sub: 'Shared defaults' },
  { key: 'audit', label: 'Audit', sub: 'Who changed what' },
];

export function orgSectionLabel(key: string): string | null {
  return ORG_SECTIONS.find((s) => s.key === key)?.label ?? null;
}
