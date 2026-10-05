// COMM-RECRUITER-W1 (W1-A2) — General Talent Contact draft context refusal. One
// error, `reason` discriminates. Talent-only (no requisition): the sole invalid
// context this slice recognizes is an absent/cross-tenant Talent.
export type TalentContactContextReason = 'talent_not_found';

export class TalentContactContextError extends Error {
  constructor(public readonly reason: TalentContactContextReason) {
    super(`talent-contact context invalid: ${reason}`);
    this.name = 'TalentContactContextError';
  }
}
