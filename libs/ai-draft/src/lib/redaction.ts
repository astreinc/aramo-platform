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
// A US phone glued to the front of an email local part ("571-509-9955jane@x.com",
// from a document whose layout lost the separator). EMAIL_RE runs first and its
// local part accepts digits and hyphens, so without this split the phone is
// captured as part of the email and never as a phone. The remainder must start
// with a letter, so an all-digit address ("5715099955@carrier.net") is untouched.
const GLUED_PHONE_PREFIX_RE = /^((?:\+?1[-.]?)?\d{3}[-.]?\d{3}[-.]?\d{4})(?=[A-Za-z])/;

// The redaction result. `emails`/`phones` are the CAPTURED raw values that were
// masked out of `redactedText` — returned so a caller can reuse them (e.g. merge
// email/phone into a recruiter prefill) WITHOUT re-scanning the text a second
// time. Invariant: exactly what is redacted from the model input is what is
// captured here, so the two can never disagree. Normalized to the prefill form
// (email lowercased; phone as ddd-ddd-ddd d from the trailing 10 digits),
// de-duplicated, in first-seen order.
export interface RedactionResult {
  readonly redactedText: string;
  readonly spanCount: number;
  readonly emails: string[];
  readonly phones: string[];
}

export function redactPii(text: string): RedactionResult {
  let redactedText = text;
  let spanCount = 0;
  const emails: string[] = [];
  const phones: string[] = [];

  redactedText = redactedText.replace(SSN_RE, () => {
    spanCount += 1;
    return '[REDACTED:SSN]';
  });

  const capturePhone = (match: string): void => {
    const digits = match.replace(/\D/g, '');
    const ten = digits.length >= 10 ? digits.slice(-10) : digits;
    if (ten.length === 10) {
      const norm = `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
      if (!phones.includes(norm)) phones.push(norm);
    }
  };

  redactedText = redactedText.replace(EMAIL_RE, (match) => {
    const glued = GLUED_PHONE_PREFIX_RE.exec(match);
    const phonePart = glued?.[1];
    const emailPart = phonePart !== undefined ? match.slice(phonePart.length) : match;
    if (phonePart !== undefined) {
      spanCount += 1;
      capturePhone(phonePart);
    }
    spanCount += 1;
    const norm = emailPart.toLowerCase();
    if (!emails.includes(norm)) emails.push(norm);
    return phonePart !== undefined ? '[REDACTED:PHONE] [REDACTED:EMAIL]' : '[REDACTED:EMAIL]';
  });

  redactedText = redactedText.replace(PHONE_RE, (match) => {
    spanCount += 1;
    capturePhone(match);
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

  return { redactedText, spanCount, emails, phones };
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
