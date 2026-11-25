// Aramo-Template-Sync-1 Directive v1.0 (LOCKED) S-3 (rulings R-4, R-9) — the ONE server rule
// that tells a company its adopted copy has a newer master version, or that the master was
// withdrawn. Computed here, on the server, for every surface (Org Home, Sign web, the Sign
// app): no UI recomputes it (§2 fact 6 — no lib reaches all three clients).
//
// §0 (amends ORG-UX-1 §5.1 and ADR-0034 D3): the lineage columns are read only to tell the
// company and to start an update it asks for. Nothing here is read by resolution or rendering,
// and nothing here changes an adopted copy.

/** The withdrawal of the master, as the notice shows it. */
export interface TemplateMasterWithdrawal {
  readonly notice_at: string;
  readonly effective_at: string;
  readonly status: 'PENDING' | 'IN_EFFECT';
}

/** The `master` object on a TENANT template adopted from an Aramo default (S-3). */
export interface TemplateMasterView {
  /** The Aramo default the copy was adopted from. */
  readonly template_id: string;
  /** Its name; null only when the default no longer exists. */
  readonly name: string | null;
  /** The default's CURRENT published version (never an earlier one, §0.2). */
  readonly current_version_id: string | null;
  readonly current_version_number: number | null;
  /** The master version the copy's current version (else its draft) is based on. */
  readonly based_on_version_number: number | null;
  readonly newer_available: boolean;
  readonly withdrawn: TemplateMasterWithdrawal | null;
  /** "Keep my version" was chosen for the master's current version (R-8). */
  readonly kept: boolean;
}

/** The PLATFORM template fields the rule reads (a DocumentTemplate row). */
export interface TemplateMasterRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly current_version_id: string | null;
  readonly withdraw_notice_at: Date | null;
  readonly withdraw_effective_at: Date | null;
}

export interface TemplateMasterInput {
  /** adopted_from_template_id of the copy. */
  readonly master_template_id: string;
  /** The master row, or null when it was deleted. */
  readonly master: TemplateMasterRow | null;
  /** version_number of master.current_version_id (null when none). */
  readonly master_current_version_number: number | null;
  /** version_number of the based-on master version (current version's, else the draft's). */
  readonly based_on_version_number: number | null;
  /** DocumentTemplate.sync_kept_platform_version_id of the copy. */
  readonly kept_version_id: string | null;
  readonly now: Date;
}

/** Whether the master's current version is numerically newer than the copy's base. */
export function masterIsNewer(master_current_version_number: number | null, based_on_version_number: number | null): boolean {
  return master_current_version_number !== null && based_on_version_number !== null && master_current_version_number > based_on_version_number;
}

export function templateMasterView(i: TemplateMasterInput): TemplateMasterView {
  const m = i.master;
  if (m === null) {
    return {
      template_id: i.master_template_id,
      name: null,
      current_version_id: null,
      current_version_number: null,
      based_on_version_number: i.based_on_version_number,
      newer_available: false,
      withdrawn: null,
      kept: false,
    };
  }
  const kept = i.kept_version_id !== null && m.current_version_id !== null && i.kept_version_id === m.current_version_id;
  const withdrawn: TemplateMasterWithdrawal | null =
    m.withdraw_notice_at !== null && m.withdraw_effective_at !== null
      ? {
          notice_at: m.withdraw_notice_at.toISOString(),
          effective_at: m.withdraw_effective_at.toISOString(),
          status: m.withdraw_effective_at.getTime() <= i.now.getTime() ? 'IN_EFFECT' : 'PENDING',
        }
      : null;
  return {
    template_id: m.id,
    name: m.name,
    current_version_id: m.current_version_id,
    current_version_number: i.master_current_version_number,
    based_on_version_number: i.based_on_version_number,
    newer_available: !kept && masterIsNewer(i.master_current_version_number, i.based_on_version_number),
    withdrawn,
    kept,
  };
}

/**
 * Whether a draft can be started from the master now (S-7): the master exists, is published
 * (ACTIVE, current version pinned) and its withdrawal has not taken effect.
 */
export function masterAvailable(master: TemplateMasterRow | null, now: Date): master is TemplateMasterRow & { current_version_id: string } {
  return (
    master !== null &&
    master.status === 'ACTIVE' &&
    master.current_version_id !== null &&
    (master.withdraw_effective_at === null || master.withdraw_effective_at.getTime() > now.getTime())
  );
}

/** §3.6 — the stable refusal reasons of the sync routes (details.reason). */
export const TEMPLATE_SYNC_REFUSALS = {
  notAdopted: 'not_an_adopted_template',
  masterNotAvailable: 'master_not_available',
  draftExists: 'draft_exists',
  alreadyCurrent: 'already_current',
} as const;
export type TemplateSyncRefusal = (typeof TEMPLATE_SYNC_REFUSALS)[keyof typeof TEMPLATE_SYNC_REFUSALS];
