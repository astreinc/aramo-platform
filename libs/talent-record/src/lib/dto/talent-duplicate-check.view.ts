// Proactive duplicate-check response — the Add-Talent "Possible existing
// Talent" card. A TalentRecord can never be duplicated on primary email (the
// create-time 409 is the hard backstop); this read lets the recruiter SEE the
// collision before pressing Create. The match projection carries only the
// display fields the card renders — no PII beyond what the pool-open talent
// list already exposes to a `talent:read` holder.
export interface TalentDuplicateMatch {
  readonly id: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly title: string | null;
  readonly city: string | null;
  readonly state: string | null;
}

export interface TalentDuplicateCheckResponse {
  readonly match: TalentDuplicateMatch | null;
}
