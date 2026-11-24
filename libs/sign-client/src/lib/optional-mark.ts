// How a signer sees that a field may be skipped — ONE wording for the web signing page and the
// Aramo Sign app (PO 2026-11-24: "one rule, one place for all UIs"). Most fields are required, so
// only an OPTIONAL field is marked; a required field shows its name alone. The "N of M required
// fields" progress and Finish still read `required` itself.
//
// Pure TypeScript ESM, no dependency (type:client-shared).

/** The mark after a caption or a field-list line: " · optional", or nothing when required. */
export function optionalMark(required: boolean): string {
  return required ? '' : ' · optional';
}

/** A caption with its mark: "Has a co-applicant · optional" (required: the caption alone). */
export function withOptionalMark(caption: string, required: boolean): string {
  return `${caption}${optionalMark(required)}`;
}

/** The mark after a field's name in its entry window: " (optional)", or nothing when required. */
export function optionalSuffix(required: boolean): string {
  return required ? '' : ' (optional)';
}
