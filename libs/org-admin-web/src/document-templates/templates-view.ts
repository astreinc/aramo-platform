import {
  TEMPLATE_PRODUCT_KEYS,
  orderedProducts,
  templateProductsLine,
  type TemplateLibraryItem,
  type TemplateLibraryView,
  type TemplateProductKey,
  type TemplateSelectionView,
  type TemplateStatus,
  type TemplateVersionView,
} from '@aramo/document-templates-web';

// ORG-UX-1 (Directive v1.0 LOCKED §5, §8.8; handoff rev. Oct 21 §6.8/§6.9) — pure
// derivations shared by Our templates and the Template gallery. No template business
// truth: the server owns the lifecycle, adoption and resolution.

/** The seeded Right-to-Represent document type key. */
export const RTR_TYPE_KEY = 'RIGHT_TO_REPRESENT';

// TEMPLATE-STUDIO-1 S-2 (directive §4.1; conforming amendment #2) — the gallery is
// BACKEND-DRIVEN: one card per published Aramo default in GET /v1/document-templates/library
// (owner_scope PLATFORM; current versions only, withdrawn defaults excluded by the server).
// The static GALLERY_ENTRIES list and its "Not configurable yet" cards are retired. A fallback
// description stays front-end, keyed by the document-type key (G13 data copy).
//
// TEMPLATE-PRODUCT-1 §4.1 / §6.4 (divergence D25) — the category is DATA: the document type's
// `category` (Platform Admin → Document types), returned in `document_types[].category`. The
// category chips are the distinct categories of the actual cards (plus All). The key map below
// is only the fallback for a type whose category is not set (null / blank, or an older server),
// and "Other" after that.

/** A gallery category: the document type's own category (free text set in Platform Admin). */
export type GalleryCategory = string;

/** The last-resort category of a card whose type has none (and no fallback below). */
export const OTHER_CATEGORY = 'Other';

/**
 * The preferred chip order for the categories the product has used so far; any other category
 * follows alphabetically, and "Other" is always last. A chip shows only when at least one card
 * is in it (empty categories are hidden).
 */
export const GALLERY_CATEGORIES: readonly string[] = ['Recruiting', 'Hiring', 'Legal', 'Pre-start'];

/** Fallback category by document-type key, used only when the type's `category` is not set. */
export const DOCUMENT_TYPE_CATEGORY: Readonly<Record<string, string>> = {
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
  /** TEMPLATE-PRODUCT-1 §6.4 — the default's product tags (the product chips filter on them). */
  readonly products: readonly string[];
}

/** The organization's own template of a document type (tenant-wide first), if any. */
export function ourTemplateOfType(library: TemplateLibraryView, documentTypeId: string): TemplateLibraryItem | null {
  const own = library.items.filter((i) => i.owner_scope === 'TENANT' && i.document_type_id === documentTypeId);
  return own.find((i) => i.client_id === null) ?? own[0] ?? null;
}

/**
 * One card per published Aramo default (PLATFORM item) of a template-driven document type.
 * The server lists only current, published, not-withdrawn defaults for the organization's
 * entitled products (TEMPLATE-PRODUCT-1 §6.3); `configurable` keeps the adoptable-types rule
 * (configured editable types, §5.1).
 */
export function buildGalleryCards(library: TemplateLibraryView): GalleryCard[] {
  const typeKey = new Map(library.document_types.map((t) => [t.id, t.key]));
  const typeCategory = new Map(library.document_types.map((t) => [t.id, t.category ?? null]));
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
        category: galleryCategoryOf(typeCategory.get(i.document_type_id) ?? null, key),
        state: ours !== null ? { kind: 'in-ours', ourTemplateId: ours.id } : { kind: 'adoptable' },
        products: orderedProducts(i.products ?? []),
      };
    });
}

/**
 * TEMPLATE-PRODUCT-1 §6.4 — the gallery's product chips: the template products the
 * organization is entitled to (canonical order). An older server that does not say → every
 * product.
 */
export function galleryProducts(library: TemplateLibraryView): TemplateProductKey[] {
  const entitled = library.entitled_products;
  return TEMPLATE_PRODUCT_KEYS.filter((k) => entitled === undefined || entitled.includes(k));
}

/** Chip counts per product (a card counts under each of its tags). */
export function productCounts(cards: readonly Pick<GalleryCard, 'products'>[], products: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = { All: cards.length };
  for (const p of products) counts[p] = cards.filter((c) => c.products.includes(p)).length;
  return counts;
}

/**
 * D25 — a card's category: the document type's `category` when set (trimmed), else the
 * fallback by type key, else "Other".
 */
export function galleryCategoryOf(category: string | null | undefined, typeKey: string): GalleryCategory {
  const own = typeof category === 'string' ? category.trim() : '';
  if (own !== '') return own;
  return DOCUMENT_TYPE_CATEGORY[typeKey] ?? OTHER_CATEGORY;
}

/**
 * D25 — the category chips (without All): each distinct category of the cards, in the preferred
 * order (GALLERY_CATEGORIES), then any other alphabetically, "Other" last.
 */
export function galleryCategories(cards: readonly Pick<GalleryCard, 'category'>[]): GalleryCategory[] {
  const position = (c: string): number => {
    if (c === OTHER_CATEGORY) return Number.MAX_SAFE_INTEGER;
    const i = GALLERY_CATEGORIES.indexOf(c);
    return i === -1 ? GALLERY_CATEGORIES.length : i;
  };
  return [...new Set(cards.map((c) => c.category))].sort((a, b) => position(a) - position(b) || a.localeCompare(b));
}

/** Chip counts (All + each category present) from the actual cards. */
export function categoryCounts(cards: readonly Pick<GalleryCard, 'category'>[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = { All: cards.length };
  for (const c of cards) counts[c.category] = (counts[c.category] ?? 0) + 1;
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

/**
 * One row per organization-owned template. "Used in" — TEMPLATE-PRODUCT-1 §6.4: the template's
 * OWN tags (server-written, inherited from the default or its document type) through the shared
 * label map ("ATS · Sign"); "—" when it has none. Version — the current (approved) version, else
 * the latest one. Last approved — the current version's activation.
 */
export function buildOurTemplateRows(
  library: TemplateLibraryView,
  versionsById: ReadonlyMap<string, readonly TemplateVersionView[]>,
): OurTemplateRow[] {
  const typeName = new Map(library.document_types.map((t) => [t.id, t.name]));
  return library.items
    .filter((i) => i.owner_scope === 'TENANT')
    .map((t) => {
      const versions = versionsById.get(t.id) ?? [];
      const current = versions.find((v) => v.id === t.current_version_id) ?? null;
      const latest = versions.reduce<TemplateVersionView | null>((m, v) => (m === null || v.version_number > m.version_number ? v : m), null);
      const n = t.current_version_number ?? current?.version_number ?? latest?.version_number ?? null;
      const usedIn = templateProductsLine(t.products ?? []);
      return {
        id: t.id,
        name: t.name,
        typeName: typeName.get(t.document_type_id) ?? 'Document',
        usedIn: usedIn !== '' ? usedIn : '—',
        version: n === null ? '—' : `v${n}`,
        status: t.status,
        lastApproved: current?.activated_at != null ? { at: current.activated_at, by: current.activated_by } : null,
        newVersion:
          current?.status === 'ACTIVE' && latest !== null && !versions.some((v) => v.status === 'DRAFT') ? latest.version_number + 1 : null,
      };
    });
}
