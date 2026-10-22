import type {
  TemplateLibraryItem,
  TemplateLibraryView,
  TemplateSelectionView,
  TemplateStatus,
  TemplateVersionView,
} from '@aramo/document-templates-web';

// ORG-UX-1 (Directive v1.0 LOCKED §5, §8.8; handoff rev. Oct 21 §6.8/§6.9) — pure
// derivations shared by Our templates and the Template gallery. No template business
// truth: the server owns the lifecycle, adoption and resolution.

/** The seeded Right-to-Represent document type key (the only template-driven type today). */
export const RTR_TYPE_KEY = 'RIGHT_TO_REPRESENT';

export type GalleryCategory = 'Recruiting' | 'Hiring' | 'Legal' | 'Pre-start';
export const GALLERY_CATEGORIES: readonly GalleryCategory[] = ['Recruiting', 'Hiring', 'Legal', 'Pre-start'];

export interface GalleryEntry {
  readonly name: string;
  readonly category: GalleryCategory;
  readonly description: string;
  /** The document type key a backend library default maps to (template-driven types only). */
  readonly typeKey: string | null;
}

// Handoff §6.9 "Contents (exact copy)". The backend document-type catalog carries no
// category or description, so this copy is used (data gap G13). Only RTR is template-driven
// (the RTR-first ruling); the other four are static "Not configurable yet" cards.
export const GALLERY_ENTRIES: readonly GalleryEntry[] = [
  {
    name: 'Right to Represent',
    category: 'Recruiting',
    description: 'Authorizes your firm to submit the talent to one client for one requisition, with the agreed pay rate.',
    typeKey: RTR_TYPE_KEY,
  },
  {
    name: 'Offer letter',
    category: 'Hiring',
    description: 'Confirms the role, start date, pay and terms offered to a talent before they start.',
    typeKey: null,
  },
  {
    name: 'Client NDA',
    category: 'Legal',
    description: 'Mutual confidentiality agreement with a client before you share talent or requisition details.',
    typeKey: null,
  },
  {
    name: 'Background check authorization',
    category: 'Pre-start',
    description: 'The talent’s consent for a background screening provider to run checks before placement.',
    typeKey: null,
  },
  {
    name: 'I-9 Employment eligibility',
    category: 'Pre-start',
    description: 'Employment eligibility verification collected from the talent before the start date.',
    typeKey: null,
  },
];

export type GalleryAvailability =
  /** Template-driven, an Aramo default exists, and the organization has none of this type. */
  | { readonly kind: 'adoptable'; readonly libraryId: string }
  /** Template-driven and the organization already has a template of this type. */
  | { readonly kind: 'in-ours'; readonly libraryId: string | null }
  /** Not template-driven (or no Aramo default is published for it). */
  | { readonly kind: 'unsupported' };

export function galleryAvailability(entry: GalleryEntry, library: TemplateLibraryView | null): GalleryAvailability {
  if (entry.typeKey === null || library === null) return { kind: 'unsupported' };
  const type = library.document_types.find((t) => t.key === entry.typeKey);
  if (type === undefined || !type.configurable) return { kind: 'unsupported' };
  const platform = library.items.find((i) => i.owner_scope === 'PLATFORM' && i.document_type_id === type.id && i.configurable) ?? null;
  const ours = library.items.some((i) => i.owner_scope === 'TENANT' && i.document_type_id === type.id);
  if (ours) return { kind: 'in-ours', libraryId: platform?.id ?? null };
  if (platform === null) return { kind: 'unsupported' };
  return { kind: 'adoptable', libraryId: platform.id };
}

/** Chip counts (All + each category), from the static entries. */
export function categoryCounts(entries: readonly GalleryEntry[]): Readonly<Record<'All' | GalleryCategory, number>> {
  const counts: Record<'All' | GalleryCategory, number> = { All: entries.length, Recruiting: 0, Hiring: 0, Legal: 0, 'Pre-start': 0 };
  for (const e of entries) counts[e.category] += 1;
  return counts;
}

/** ORG-UX-1 §5.3 — a grandfathered tenant-wide selection of an Aramo default. */
export function hasLegacySelection(selections: readonly TemplateSelectionView[]): boolean {
  return selections.some((s) => s.client_id === null && s.legacy_platform === true);
}

export interface OurTemplateRow {
  readonly id: string;
  readonly name: string;
  readonly typeName: string;
  readonly usedIn: string;
  readonly version: string;
  readonly status: TemplateStatus;
  readonly lastApproved: { readonly at: string; readonly by: string | null } | null;
}

const PRODUCT_LABEL: Readonly<Record<string, string>> = { ATS: 'ATS', SIGN: 'Sign' };

/**
 * One row per organization-owned template. "Used in" — a tenant template carries no product
 * tags, so it shows the tags of the Aramo default of the same document type, else "All apps".
 * Version — the current (approved) version, else the latest one. Last approved — the
 * current version's activation.
 */
export function buildOurTemplateRows(
  library: TemplateLibraryView,
  versionsById: ReadonlyMap<string, readonly TemplateVersionView[]>,
): OurTemplateRow[] {
  const typeName = new Map(library.document_types.map((t) => [t.id, t.name]));
  const platformByType = new Map<string, TemplateLibraryItem>();
  for (const i of library.items) if (i.owner_scope === 'PLATFORM' && !platformByType.has(i.document_type_id)) platformByType.set(i.document_type_id, i);
  return library.items
    .filter((i) => i.owner_scope === 'TENANT')
    .map((t) => {
      const versions = versionsById.get(t.id) ?? [];
      const current = versions.find((v) => v.id === t.current_version_id) ?? null;
      const latest = versions.reduce<TemplateVersionView | null>((m, v) => (m === null || v.version_number > m.version_number ? v : m), null);
      const n = t.current_version_number ?? current?.version_number ?? latest?.version_number ?? null;
      const tags = (platformByType.get(t.document_type_id)?.products ?? []).map((p) => PRODUCT_LABEL[p] ?? p);
      return {
        id: t.id,
        name: t.name,
        typeName: typeName.get(t.document_type_id) ?? 'Document',
        usedIn: tags.length > 0 ? tags.join(' · ') : 'All apps',
        version: n === null ? '—' : `v${n}`,
        status: t.status,
        lastApproved: current?.activated_at != null ? { at: current.activated_at, by: current.activated_by } : null,
      };
    });
}
