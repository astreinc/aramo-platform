// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5…) §1.9 — knowledge-based
// authentication (KBA) — under Amendment A1 (dc95b283…): NO vendor is selected (D-3), so KBA
// gets the vendor-neutral port and a DISABLED adapter only. A vendor adapter (e.g. a US
// identity-data bureau's question-and-answer service) is added when the PO selects and
// contracts one. KBA is US-only in practice (§1.9 "Vendors").
//
// R-5: questions and answers stay at the vendor. Aramo would keep only the outcome and the
// vendor's reference, exactly as for government-ID verification.

export const KBA_PORT = 'KBA_PORT';

export interface KbaSubject {
  /** The recipient's name as the sender entered it. */
  full_name: string;
  /** Address details a vendor needs to build the questions (collected from the recipient). */
  address?: { line1: string; city: string; region: string; postal_code: string; country: string };
}

export interface KbaQuestion {
  question_ref: string;
  text: string;
  choices: ReadonlyArray<{ choice_ref: string; text: string }>;
}

export interface StartedKbaQuiz {
  vendor_reference: string;
  questions: readonly KbaQuestion[];
}

export interface KbaOutcome {
  vendor_reference: string;
  outcome: 'VERIFIED' | 'FAILED';
  failure_code: string | null;
}

export interface KbaPort {
  readonly provider: string;
  isConfigured(): boolean;
  startQuiz(input: { attempt_id: string; tenant_id: string; subject: KbaSubject }): Promise<StartedKbaQuiz>;
  submitAnswers(vendor_reference: string, answers: ReadonlyArray<{ question_ref: string; choice_ref: string }>): Promise<KbaOutcome>;
}

/** KBA is not available: no vendor is selected. Every call is refused. */
export class KbaUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`knowledge-based authentication unavailable: ${reason}`);
    this.name = 'KbaUnavailableError';
  }
}

export class DisabledKbaAdapter implements KbaPort {
  readonly provider = 'DISABLED';

  isConfigured(): boolean {
    return false;
  }

  startQuiz(): Promise<StartedKbaQuiz> {
    return Promise.reject(new KbaUnavailableError('kba_vendor_not_selected'));
  }

  submitAnswers(): Promise<KbaOutcome> {
    return Promise.reject(new KbaUnavailableError('kba_vendor_not_selected'));
  }
}

/**
 * SIGN_KBA_PROVIDER — no vendor value is accepted yet: unset (the default), `disabled` and
 * any other value all resolve to the disabled adapter (fail closed).
 */
export function kbaProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KbaPort {
  const requested = (env['SIGN_KBA_PROVIDER'] ?? '').trim().toLowerCase();
  if (requested !== '' && requested !== 'disabled') {
    // A named vendor has no adapter until one is selected (D-3): stay disabled.
    return new DisabledKbaAdapter();
  }
  return new DisabledKbaAdapter();
}
