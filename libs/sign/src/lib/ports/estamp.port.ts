// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.19 (stamp duty payment,
// India) under Amendment A1: the VENDOR-NEUTRAL port for buying Indian e-stamp paper
// through an e-stamp aggregator or a state e-stamp portal and attaching it to an
// envelope. No aggregator is selected (§5 D-3), so only the `disabled` adapter exists;
// a vendor adapter is added when the PO contracts one. Nothing is marketed or sold (R-2).
//
// Aramo does not compute stamp duty and does not decide which article of which state's
// stamp act applies: the sender supplies the state, the article and the amount, and the
// aggregator issues the certificate. Stamp duty is payable to the state through the
// aggregator; Aramo never holds those funds.

export const ESTAMP_PORT = 'ESTAMP_PORT';

/** The e-stamp purchase request, as the sender entered it. Amounts are in paise (INR × 100). */
export interface EstampOrderInput {
  /** Aramo's order id, sent as the aggregator's idempotency key / client reference. */
  order_id: string;
  /** ISO 3166-2:IN subdivision code of the stamping state, e.g. "IN-KA". */
  state_code: string;
  /** The article of that state's stamp act, as the aggregator names it (free text). */
  article_code: string;
  stamp_duty_amount_paise: number;
  /** Consideration amount, where the article's duty depends on it; null otherwise. */
  consideration_amount_paise: number | null;
  first_party: string;
  second_party: string;
  /** Who buys the stamp paper (one of the parties, or their representative). */
  purchaser: string;
  description: string | null;
}

export type EstampOrderStatus = 'PENDING' | 'ISSUED' | 'FAILED';

export interface EstampOrderResult {
  provider_order_ref: string;
  status: EstampOrderStatus;
}

export type EstampCertificateResult =
  | { status: 'PENDING' }
  | { status: 'FAILED'; reason: string }
  | {
      status: 'ISSUED';
      /** The unique e-stamp certificate number printed on the paper. */
      certificate_number: string;
      issued_at: Date;
      /** The e-stamp certificate as a PDF, to be placed in front of the document. */
      pdf: Uint8Array;
    };

export interface EstampPort {
  /** Stable adapter key recorded in evidence (e.g. "disabled"). */
  readonly provider: string;
  /** false ⇒ no aggregator is configured; every method refuses. */
  readonly configured: boolean;
  order(input: EstampOrderInput): Promise<EstampOrderResult>;
  certificate(provider_order_ref: string): Promise<EstampCertificateResult>;
}

/** Raised when an e-stamp is requested but no aggregator adapter is configured. */
export class EstampProviderNotConfiguredError extends Error {
  constructor() {
    super('No e-stamp provider is configured');
    this.name = 'EstampProviderNotConfiguredError';
  }
}

/** The only adapter until an aggregator is contracted (Amendment A1 §A1.1). */
export class DisabledEstampAdapter implements EstampPort {
  readonly provider = 'disabled';
  readonly configured = false;
  async order(): Promise<EstampOrderResult> {
    throw new EstampProviderNotConfiguredError();
  }
  async certificate(): Promise<EstampCertificateResult> {
    throw new EstampProviderNotConfiguredError();
  }
}
