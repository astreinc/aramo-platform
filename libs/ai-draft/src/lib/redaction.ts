// M5 PR-5 §4.8 — local PII redaction utility. Five patterns per Ruling 6
// (closed; opt-out is NOT configurable at PR-5):
//   - US SSN (XXX-XX-XXXX with invalid-area-number guards)
//   - email address (RFC-style local-part@domain)
//   - US phone number (10-digit with optional country code + formatting)
//   - credit-card number (13-19 digits, Luhn-valid only)
//   - US bank routing number (9-digit ABA, checksum-valid only)
//
// Two-pass design: scan with each pattern, replace each match with the
// [REDACTED:KIND] sentinel, accumulate span count across all 5 patterns.
// Luhn + ABA validation gates the CC + routing replacements — random
// 13-19 / 9 digit sequences that fail the check pass through unchanged.

const SSN_RE = /\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?<!\d)(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}(?!\d)/g;
const CC_RE = /\b\d{13,19}\b/g;
const ROUTING_RE = /\b\d{9}\b/g;

export function redactPii(text: string): { redactedText: string; spanCount: number } {
  let redactedText = text;
  let spanCount = 0;

  redactedText = redactedText.replace(SSN_RE, () => {
    spanCount += 1;
    return '[REDACTED:SSN]';
  });

  redactedText = redactedText.replace(EMAIL_RE, () => {
    spanCount += 1;
    return '[REDACTED:EMAIL]';
  });

  redactedText = redactedText.replace(PHONE_RE, () => {
    spanCount += 1;
    return '[REDACTED:PHONE]';
  });

  redactedText = redactedText.replace(CC_RE, (match) => {
    if (luhnCheck(match)) {
      spanCount += 1;
      return '[REDACTED:CC]';
    }
    return match;
  });

  redactedText = redactedText.replace(ROUTING_RE, (match) => {
    if (abaCheck(match)) {
      spanCount += 1;
      return '[REDACTED:ROUTING]';
    }
    return match;
  });

  return { redactedText, spanCount };
}

export function luhnCheck(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function abaCheck(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d: number[] = [];
  for (let i = 0; i < 9; i++) {
    d.push(digits.charCodeAt(i) - 48);
  }
  const [d0, d1, d2, d3, d4, d5, d6, d7, d8] = d as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const checksum =
    (3 * (d0 + d3 + d6) + 7 * (d1 + d4 + d7) + 1 * (d2 + d5 + d8)) % 10;
  return checksum === 0;
}
