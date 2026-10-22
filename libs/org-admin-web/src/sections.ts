// ORG-UX-1 (Directive v1.0 LOCKED §1, §3; App Home & Organization handoff rev. Oct 21
// §2/§3) — the Organization sections as MAIN-NAV items (no horizontal tabs). ONE registry
// drives the left nav, the top-bar breadcrumb, the routes and App Home's shortcuts, so
// they can never disagree.
//
//   ORGANIZATION (org admins)   Overview · Profile · Users & invitations · Roles & access ·
//                               Sites · Domain
//   SHARED SETUP (org admins;   Settings · Our templates · Template gallery · Audit
//    template authors see only Our templates + Template gallery — §4.3 org_access)
//
// Paths are production's (H10/P6): Our templates = /org/document-templates, the gallery =
// /org/document-templates/gallery.

/** The SHARED SETUP heading — one constant ("Shared setup" may become "Administration"). */
export const SHARED_SETUP_HEADING = 'Shared setup';
export const ORGANIZATION_HEADING = 'Organization';

export type OrgSectionKey =
  | 'overview'
  | 'profile'
  | 'users'
  | 'roles'
  | 'sites'
  | 'domain'
  | 'settings'
  | 'templates'
  | 'gallery'
  | 'audit';

export interface OrgSection {
  readonly key: OrgSectionKey;
  readonly label: string;
  /** Absolute path under the home-web mount. */
  readonly path: string;
  readonly group: 'organization' | 'shared';
  /** 24-viewBox stroke path (stroke 1.7) — handoff §2 icon table. */
  readonly iconPath: string;
  /** Adds the gear's centre circle (Settings). */
  readonly gear?: boolean;
  /** Visible to template authors without organization administration. */
  readonly templateAuthor?: boolean;
}

const ICON = {
  overview: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  // Companies icon (building).
  profile: 'M4 21V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 10h5a1 1 0 0 1 1 1v10M2 21h20M8 9h2M8 13h2M8 17h2',
  // Talent icon (people).
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  // shield-check.
  roles: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  // pin.
  sites: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  // globe.
  domain: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z',
  // gear (with centre circle).
  settings:
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  templates: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
  gallery: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5',
  // the checklist icon.
  audit: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
} as const;

export const ORG_SECTIONS: readonly OrgSection[] = [
  { key: 'overview', label: 'Overview', path: '/org/overview', group: 'organization', iconPath: ICON.overview },
  { key: 'profile', label: 'Profile', path: '/org/profile', group: 'organization', iconPath: ICON.profile },
  { key: 'users', label: 'Users & invitations', path: '/org/users', group: 'organization', iconPath: ICON.users },
  { key: 'roles', label: 'Roles & access', path: '/org/roles', group: 'organization', iconPath: ICON.roles },
  { key: 'sites', label: 'Sites', path: '/org/sites', group: 'organization', iconPath: ICON.sites },
  { key: 'domain', label: 'Domain', path: '/org/domain', group: 'organization', iconPath: ICON.domain },
  { key: 'settings', label: 'Settings', path: '/org/settings', group: 'shared', iconPath: ICON.settings, gear: true },
  { key: 'templates', label: 'Our templates', path: '/org/document-templates', group: 'shared', iconPath: ICON.templates, templateAuthor: true },
  { key: 'gallery', label: 'Template gallery', path: '/org/document-templates/gallery', group: 'shared', iconPath: ICON.gallery, templateAuthor: true },
  { key: 'audit', label: 'Audit', path: '/org/audit', group: 'shared', iconPath: ICON.audit },
];

/** The page intro line under each H1 (handoff §6, exact copy). `{Org}` is substituted. */
export const ORG_SECTION_INTRO: Readonly<Record<OrgSectionKey, string>> = {
  overview: 'Everything every Aramo app shares about {Org}: people, access, sites and documents.',
  profile: "Your organization's legal identity, address and contact. Every Aramo app uses it.",
  users:
    'Everyone in your organization. Invite people, resend invitations and manage who can sign in. Change a person’s roles with Edit access; see who holds each role in Roles & access.',
  roles: 'Every role in each Aramo app and who holds it. To change one person’s access, use Edit access in Users & invitations.',
  sites: 'Offices and delivery centres. ATS teams are scoped to a site.',
  domain: 'Prove your organization controls its email domain, and review how people sign in.',
  settings: 'Shared defaults for every Aramo app.',
  templates: 'Approved documents your apps send. Edits create a new draft version; apps always use the active version.',
  // ORG-UX-1 §5.5 — plus the responsibility sentence.
  gallery:
    'Ready-made starting points. Adopting one creates a draft in Our templates; nothing is used until you approve it. Your organization is responsible for the content of any template it approves.',
  audit: 'Who changed what in your organization.',
};

/** ORG-UX-1 §4.3 — the server-evaluated Organization access tier. */
export type OrgAccessTier = 'admin' | 'templates' | 'none';

/** The sections a tier may open (admin = all; templates = Our templates + gallery). */
export function orgSectionsFor(access: OrgAccessTier): readonly OrgSection[] {
  if (access === 'admin') return ORG_SECTIONS;
  if (access === 'templates') return ORG_SECTIONS.filter((s) => s.templateAuthor === true);
  return [];
}

export function orgSectionByKey(key: OrgSectionKey): OrgSection {
  const s = ORG_SECTIONS.find((x) => x.key === key);
  if (s === undefined) throw new Error(`unknown org section ${key}`);
  return s;
}

/** The section a pathname belongs to (longest path match), or null. */
export function orgSectionForPath(pathname: string): OrgSection | null {
  const p = pathname.replace(/\/+$/, '');
  if (p === '/org') return orgSectionByKey('overview');
  let best: OrgSection | null = null;
  for (const s of ORG_SECTIONS) {
    if (p === s.path || p.startsWith(`${s.path}/`)) {
      if (best === null || s.path.length > best.path.length) best = s;
    }
  }
  return best;
}

/** Back-compat: the label for a section key (top-bar breadcrumb). */
export function orgSectionLabel(key: string): string | null {
  return ORG_SECTIONS.find((s) => s.key === key)?.label ?? null;
}
