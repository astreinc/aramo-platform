// Consolidated Directive v1.0 B2 — the sender's per-recipient options, each shown ONLY
// while GET /v1/sign/sender/context reports it available (`features.<key> === true`).
// The server checks every choice again (launch availability and plan).

export interface SendFeatures {
  readonly witness: boolean;
  readonly delegation: boolean;
  readonly accessCode: boolean;
  readonly sms: boolean;
  readonly whatsapp: boolean;
  readonly smsCode: boolean;
  readonly idCheck: boolean;
  readonly kba: boolean;
}

export const NO_SEND_FEATURES: SendFeatures = {
  witness: false,
  delegation: false,
  accessCode: false,
  sms: false,
  whatsapp: false,
  smsCode: false,
  idCheck: false,
  kba: false,
};

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** The options from the sender context (absent keys = not available). */
export function sendFeaturesOf(context: unknown): SendFeatures {
  const f = rec(rec(context)['features']);
  const on = (k: string) => f[k] === true;
  return {
    witness: on('witness_signing'),
    delegation: on('delegate_signing'),
    accessCode: on('access_code'),
    sms: on('sms_delivery'),
    whatsapp: on('whatsapp_delivery'),
    smsCode: on('sms_otp'),
    idCheck: on('id_verification'),
    kba: on('kba'),
  };
}

/** Any text option is offered (GET …/messaging is refused otherwise). */
export function messagingOffered(f: SendFeatures): boolean {
  return f.sms || f.whatsapp || f.smsCode;
}
