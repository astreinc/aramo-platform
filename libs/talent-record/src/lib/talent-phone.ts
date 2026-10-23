// ATI-SEP-1 A2 — the cell-phone DEDUPE key (TalentRecord.phone_cell_normalized).
// Digits only; a 10-digit number is read as NANP and prefixed with country code
// 1, so "(571) 435-5777", "571.435.5777" and "+1 571 435 5777" share one key
// (E.164-ish, without the '+'). Deterministic, no inference. The SAME rule
// backfilled the column in migration 20261024130000. null when there is no digit.
export function normalizePhoneForDedupe(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length === 0) return null;
  return digits.length === 10 ? `1${digits}` : digits;
}
