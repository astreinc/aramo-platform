// Feature-Parity §1.9 — the conservative name-match policy. The name on the verified document
// must match the recipient's name as the sender entered it: the document's first given name
// and every part of its family name must appear among the recipient's name parts. Case,
// accents, punctuation and extra middle names are ignored. Anything else is a mismatch, and a
// mismatch FAILS the verification (the sender is told and can correct the recipient).

/** Lower-case name parts without accents or punctuation. */
export function nameTokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/['-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function verifiedNameMatches(verified: { first: string; last: string } | null, recipientName: string): boolean {
  if (verified === null) return false;
  const recipient = new Set(nameTokens(recipientName));
  const first = nameTokens(verified.first)[0];
  const last = nameTokens(verified.last);
  if (first === undefined || last.length === 0 || recipient.size === 0) return false;
  return recipient.has(first) && last.every((t) => recipient.has(t));
}
