// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §4 — document type classes
// and kinds (columns added by migration 20261103110000; DB CHECKs there) and the
// system-locked types code depends on.

/** UPLOAD = an upload slot (the TALENT_* types), never a template. */
export const DOCUMENT_TYPE_CLASSES = ['TEMPLATE', 'UPLOAD'] as const;
export type DocumentTypeClass = (typeof DOCUMENT_TYPE_CLASSES)[number];

/** NULL (not in this list) = not yet configured: the type is not usable for templates. */
export const DOCUMENT_TYPE_TEMPLATE_KINDS = ['EDITABLE', 'FIXED_FORM'] as const;
export type DocumentTypeTemplateKind = (typeof DOCUMENT_TYPE_TEMPLATE_KINDS)[number];

/** The signing (execution mode) values of DocumentType.execution_mode_default (DOC-1a CHECK). */
export const DOCUMENT_EXECUTION_MODES = ['NO_SIGNATURE', 'ACKNOWLEDGEMENT', 'SINGLE_SIGNATURE', 'MULTI_SIGNATURE'] as const;
export type DocumentExecutionMode = (typeof DOCUMENT_EXECUTION_MODES)[number];

export const RIGHT_TO_REPRESENT_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';
export const OFFER_LETTER_TYPE_ID = 'd0c50006-0000-7000-8000-000000000001';

/**
 * §4.2 — types code depends on. RIGHT_TO_REPRESENT: name, description, category and products
 * editable; kind fixed EDITABLE; never retired or deleted. OFFER_LETTER: description only
 * (shown "Not yet available for templates", PLATFORM-UX-1 F-8 unchanged).
 */
export const SYSTEM_LOCKED_TYPE_IDS: readonly string[] = [RIGHT_TO_REPRESENT_TYPE_ID, OFFER_LETTER_TYPE_ID];

/** The fields Platform Admin may change on a system-locked type. */
export const SYSTEM_LOCKED_EDITABLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [RIGHT_TO_REPRESENT_TYPE_ID]: ['name', 'description', 'category', 'products'],
  [OFFER_LETTER_TYPE_ID]: ['description'],
};

export function isSystemLockedType(id: string): boolean {
  return SYSTEM_LOCKED_TYPE_IDS.includes(id);
}

/**
 * The key a new type gets from its name (§4.3): upper snake, ASCII letters and digits only
 * ("Mutual NDA (2026)" → "MUTUAL_NDA_2026"), at most 64 characters. Empty when the name has
 * no letter or digit.
 */
export function documentTypeKeyFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/g, '');
}

/** The template configuration columns of a document type (§4.1) — what §5.1 decides on. */
export interface DocumentTypeTemplateConfig {
  readonly id: string;
  readonly active: boolean;
  readonly type_class: string;
  readonly template_kind: string | null;
  readonly products: readonly string[];
}

/**
 * TEMPLATE-PRODUCT-1 §5.1 — a type is configurable for the generic editable contract (the
 * `rtr-html-v1` content contract, §5.2) iff it is active, a TEMPLATE type and its kind is
 * EDITABLE. Fixed forms have their own path (§7); an unconfigured kind (NULL) is never usable.
 */
export function isConfiguredEditableType(t: DocumentTypeTemplateConfig | null | undefined): boolean {
  return t !== null && t !== undefined && t.active && t.type_class === 'TEMPLATE' && t.template_kind === 'EDITABLE';
}

/** The read seam the capability port decides configurability from (a fake in unit tests). */
export interface DocumentTypeTemplateConfigReader {
  findDocumentTypeTemplateConfig(id: string): Promise<DocumentTypeTemplateConfig | null>;
}
