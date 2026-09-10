// Display-only phone formatter. The STORED value is never mutated — this only
// shapes how a number reads in the UI. US 10-digit → (512) 555-0147; a leading
// US country code (11 digits starting with 1) is folded the same way. Anything
// that isn't a clean 10/11-digit US number (international, extensions, partial)
// is returned UNCHANGED so a real value is never mangled or hidden.
export function formatPhone(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    const d = digits.slice(1);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return value;
}
