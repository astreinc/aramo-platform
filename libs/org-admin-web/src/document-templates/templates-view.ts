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

// TEMPLATE-STUDIO-1 S-2 (directive §4.1; conforming amendment #2) — the gallery is
// BACKEND-DRIVEN: one card per published Aramo default in GET /v1/document-templates/library
// (owner_scope PLATFORM; current versions only, withdrawn defaults excluded by the server).
// The static GALLERY_ENTRIES list and its "Not configurable yet" cards are retired. Only the
// category and a fallback description stay front-end, keyed by the document-type key (G13 data
// copy: the backend document-type catalog carries neither). Keys for types that are not
// publishable yet are listed so they categorise automatically once they are.

export type GalleryCategory = 'Recruiting' | 'Hiring' | 'Legal' | 'Pre-start' | 'Other';
/** Chip order; a chip shows only when at least one card is in it (empty categories are hidden). */
export const GALLERY_CATEGORIES: readonly GalleryCategory[] = ['Recruiting', 'Hiring', 'Legal', 'Pre-start', 'Other'];

export const DOCUMENT_TYPE_CATEGORY: Readonly<Record<string, GalleryCategory>> = {
  RIGHT_TO_REPRESENT: 'Recruiting',
  OFFER_LETTER: 'Hiring',
  CLIENT_NDA: 'Legal',
  BACKGROUND_AUTHORIZATION: 'Pre-start',
  I9: 'Pre-start',
};

// Handoff §6.9 "Contents (exact copy)" — used when a default carries no description.
export const DOCUMENT_TYPE_DESCRIPTION: Readonly<Record<string, string>> = {
  RIGHT_TO_REPRESENT: 'Authorizes your firm to submit the talent to one client for one requisition, with the agreed pay rate.',
  OFFER_LETTER: 'Confirms the role, start date, pay and terms offered to a talent before they start.',
  CLIENT_NDA: 'Mutual confidentiality agreement with a client before you share talent or requisition details.',
  BACKGROUND_AUTHORIZATION: 'The talent’s consent for a background screening provider to run checks before placement.',
  I9: 'Employment eligibility verification collected from the talent before the start date.',
};

export type GalleryState =
  /** The organization has no template of this document type: preview, then Adopt. */
  | { readonly kind: 'adoptable' }
  /** The organization already has a template of this type: link to it. */
  | { readonly kind: 'in-ours'; readonly ourTemplateId: string };

export interface GalleryCard {
  /** The Aramo default's library id (opens /aramo/:id). */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: GalleryCategory;
  readonly state: GalleryState;
}

/** The organization's own template of a document type (tenant-wide first), if any. */
export function ourTemplateOfType(library: TemplateLibraryView, documentTypeId: string): TemplateLibraryItem | null {
  const own = library.items.filter((i) => i.owner_scope === 'TENANT' && i.document_type_id === documentTypeId);
  return own.find((i) => i.client_id === null) ?? own[0] ?? null;
}

/**
 * One card per published Aramo default (PLATFORM item) of a template-driven document type.
 * The server lists only current, published, not-withdrawn defaults; `configurable` keeps
 * the adoptable-types rule (template-driven types only; RTR today).
 */
export function buildGalleryCards(library: TemplateLibraryView): GalleryCard[] {
  const typeKey = new Map(library.document_types.map((t) => [t.id, t.key]));
  return library.items
    .filter((i) => i.owner_scope === 'PLATFORM' && i.configurable)
    .map((i) => {
      const key = typeKey.get(i.document_type_id) ?? '';
      const ours = ourTemplateOfType(library, i.document_type_id);
      const description = i.description !== null && i.description.trim() !== '' ? i.description : (DOCUMENT_TYPE_DESCRIPTION[key] ?? '');
      return {
        id: i.id,
        name: i.name,
        description,
        category: DOCUMENT_TYPE_CATEGORY[key] ?? 'Other',
        state: ours !== null ? { kind: 'in-ours', ourTemplateId: ours.id } : { kind: 'adoptable' },
      };
    });
}

/** Chip counts (All + each category) from the actual cards. */
export function categoryCounts(cards: readonly Pick<GalleryCard, 'category'>[]): Readonly<Record<'All' | GalleryCategory, number>> {
  const counts: Record<'All' | GalleryCategory, number> = { All: cards.length, Recruiting: 0, Hiring: 0, Legal: 0, 'Pre-start': 0, Other: 0 };
  for (const c of cards) counts[c.category] += 1;
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
  /**
   * TEMPLATE-STUDIO-1 (directive §1.4, §3.4) — the "Create new version" number: set when the
   * template has an ACTIVE (approved) version and no open draft (null otherwise, including
   * when the versions could not be read).
   */
  readonly newVersion: number | null;
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
        newVersion:
          current?.status === 'ACTIVE' && latest !== null && !versions.some((v) => v.status === 'DRAFT') ? latest.version_number + 1 : null,
      };
    });
}
