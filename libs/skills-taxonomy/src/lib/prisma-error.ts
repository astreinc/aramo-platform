// Prisma 7 + PrismaPg error-shape helpers (SKILL-TAX-1). Unique-index
// violations surface at meta.driverAdapterError.cause.originalMessage /
// .constraint.fields — NOT meta.target — and a plain unique violation may also
// leak untranslated. These helpers inspect ALL of those locations so the
// load-bearing index (e.g. normalized_name / normalized_alias) is correctly
// identified regardless of which shape the driver produced.

function haystack(e: unknown): string {
  const anyE = e as {
    code?: string;
    meta?: Record<string, unknown>;
    message?: string;
    cause?: Record<string, unknown>;
  };
  const meta = anyE?.meta ?? {};
  const cause =
    ((meta['driverAdapterError'] as { cause?: Record<string, unknown> } | undefined)?.cause) ??
    anyE?.cause ??
    {};
  const original = (cause['originalMessage'] as string | undefined) ?? '';
  const fields = (cause['constraint'] as { fields?: unknown } | undefined)?.fields;
  const target = meta['target'];
  return [
    original,
    Array.isArray(fields) ? fields.join(',') : String(fields ?? ''),
    Array.isArray(target) ? target.join(',') : String(target ?? ''),
    anyE?.message ?? String(anyE ?? ''),
  ].join(' ');
}

export function isUniqueViolation(e: unknown): boolean {
  const anyE = e as { code?: string };
  const hay = haystack(e);
  return anyE?.code === 'P2002' || hay.includes('duplicate key') || hay.includes('_key');
}

// True when a unique violation names the given column/index token (e.g.
// 'normalized_name', 'normalized_alias', 'normalized_version', 'canonical_name').
export function uniqueViolationOn(e: unknown, needle: string): boolean {
  return isUniqueViolation(e) && haystack(e).includes(needle);
}

export function isNotFound(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2025';
}
