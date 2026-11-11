// CCP Billing Products — minor-unit money helpers shared by the provider clients (BP-5 exact amounts).

/** ISO 4217 minor-unit exponents that are not 2 (every other currency is 2). */
const EXPONENT: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function currencyExponent(currency: string): number {
  return EXPONENT[currency.toUpperCase()] ?? 2;
}

/** A decimal string ("9.99", "999.0", "10") → minor units, exactly (no float rounding); null if malformed. */
export function decimalToMinor(value: string, currency: string): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (m === null) return null;
  const exp = currencyExponent(currency);
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > exp) return null;
  return Number(m[1]) * 10 ** exp + (frac === '' ? 0 : Number(frac.padEnd(exp, '0')));
}

/** Minor units → a decimal string ("1000", USD → "10.00"). */
export function minorToDecimal(amount_minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  if (exp === 0) return String(amount_minor);
  const s = String(Math.abs(amount_minor)).padStart(exp + 1, '0');
  return `${amount_minor < 0 ? '-' : ''}${s.slice(0, -exp)}.${s.slice(-exp)}`;
}
