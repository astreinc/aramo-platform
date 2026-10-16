// Shared resolver for backend vocabulary codes → display labels. Codes never reach
// the screen raw: each vocabulary keeps its own exported `*_LABELS` map next to its
// FE type, and its `xxxLabel(code)` helper resolves through here. An unknown code
// (a new backend value the FE has not mirrored yet) degrades to readable sentence
// case instead of leaking SCREAMING_SNAKE / kebab-case.

/** `CLIENT_REVIEW` / `pre-start` / `consent.grant.recorded` → "Client review" / "Pre start" / "Consent grant recorded". */
export function sentenceCaseCode(code: string): string {
  const t = code.replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Exact match first, then case-insensitive (lower / upper), then the sentence-case fallback. */
export function codeLabel(map: Readonly<Record<string, string>>, code: string): string {
  for (const k of [code, code.toLowerCase(), code.toUpperCase()]) {
    if (Object.prototype.hasOwnProperty.call(map, k)) return map[k] as string;
  }
  return sentenceCaseCode(code);
}

// A machine code: snake / kebab / dotted tokens with no spaces, or a single all-lowercase /
// all-caps word. Anything else (spaces, mixed case) is human text.
const CODE_SHAPE = /^(?:[A-Za-z0-9]+(?:[_.-][A-Za-z0-9]+)+|[a-z0-9]+|[A-Z0-9]+)$/;
export function looksLikeCode(value: string): boolean {
  return CODE_SHAPE.test(value.trim());
}

/** For a field that carries EITHER a vocabulary code OR human free text: codes map, text passes through. */
export function codeOrTextLabel(map: Readonly<Record<string, string>>, value: string): string {
  const t = value.trim();
  return looksLikeCode(t) ? codeLabel(map, t) : t;
}
