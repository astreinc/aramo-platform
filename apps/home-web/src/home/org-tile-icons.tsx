import {
  IconBuilding,
  IconFile,
  IconGlobe,
  IconHistory,
  IconPin,
  IconShieldCheck,
  IconSliders,
  IconUsers,
} from '@aramo/fe-foundation';

// Icons for the Organization administration tiles on App Home (same set as the
// frozen prototype's tiles: building, people, shield, pin, globe, gear, audit).
export function OrgTileIcon({ section }: { readonly section: string }) {
  switch (section) {
    case 'profile':
      return <IconBuilding />;
    case 'users':
      return <IconUsers />;
    case 'roles':
      return <IconShieldCheck />;
    case 'sites':
      return <IconPin />;
    case 'domain':
      return <IconGlobe />;
    case 'settings':
      return <IconSliders />;
    // DOC-TEMPLATE-LIB-1 T-4 — Org Home "Document templates".
    case 'document-templates':
      return <IconFile />;
    default:
      return <IconHistory />;
  }
}
