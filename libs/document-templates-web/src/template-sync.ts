// Aramo-Template-Sync-1 Directive v1.0 (LOCKED) S-3 / S-9 / S-10 / S-12 — "a newer master is
// available" in the shared template UI. The rule itself is computed ONCE, on the server (the
// `master` object on every template, library and studio item, R-4); this module only maps the
// server's flags to words. S-12 — the ONE set of user-facing strings, used by Org Home and Sign
// web (the Sign app keeps its own copy of the two badge strings, mirroring the server flag).

/** The server-computed master of an adopted template (GET /v1/document-templates*, library, studio). */
export interface TemplateMaster {
  readonly template_id: string;
  readonly name: string | null;
  readonly current_version_id: string | null;
  readonly current_version_number: number | null;
  readonly based_on_version_number: number | null;
  readonly newer_available: boolean;
  readonly withdrawn: { readonly notice_at: string; readonly effective_at: string; readonly status: 'PENDING' | 'IN_EFFECT' } | null;
  readonly kept: boolean;
}

/** S-5 — the master's CURRENT version content (GET /v1/document-templates/:id/master). */
export interface TemplateMasterContent {
  readonly template_id: string;
  readonly master_template_id: string;
  readonly version_id: string;
  readonly version_number: number;
  readonly render_schema_version: string;
  readonly title: string | null;
  readonly html: string | null;
  readonly signing: unknown;
}

/** S-12 — the one set of words (Org Home, Sign web Personal and Business). */
export const TEMPLATE_SYNC_COPY = {
  /** The row badge (S-9 / S-10). */
  badgeNewer: 'Newer version available',
  badgeWithdrawn: 'Withdrawn by Aramo',
  /** Sign web Business (S-11): a badge only — the update happens in Org Home. */
  badgeNewerUseOnly: 'Newer version available — your administrator updates it in Org Home',
  /** The list banner (S-9 / S-10). */
  banner: (n: number): string => (n === 1 ? 'Aramo updated 1 template you use' : `Aramo updated ${n} templates you use`),
  bannerDetail: 'Open a template to compare it with Aramo’s new version, start a draft from it, or keep your version.',
  /** The Studio notice. */
  notice: (m: TemplateMaster): string => {
    const name = m.name ?? 'this template';
    const published = m.current_version_number !== null ? `version ${m.current_version_number}` : 'a new version';
    const based = m.based_on_version_number !== null ? ` Your template is based on version ${m.based_on_version_number}.` : '';
    return `Aramo published ${published} of ${name}.${based}`;
  },
  noticeUnchanged: 'Your template stays as it is until you approve a new version.',
  withdrawnNotice: (m: TemplateMaster): string => {
    const when = m.withdrawn?.status === 'IN_EFFECT' ? 'has withdrawn' : 'is withdrawing';
    return `Aramo ${when} ${m.name ?? 'the template'} this one was adopted from. Your template is not changed.`;
  },
  /** S-4 — the withdrawal notice of an ADOPTED copy (the list banner). */
  adoptedWithdrawal: (copyName: string, status: 'PENDING' | 'IN_EFFECT', effective: string): string =>
    status === 'IN_EFFECT'
      ? `Aramo withdrew the Aramo template “${copyName}” was adopted from on ${effective}. Your template is not changed and stays in use.`
      : `Aramo is withdrawing the Aramo template “${copyName}” was adopted from, from ${effective}. Your template is not changed and stays in use.`,
  compare: 'Compare with Aramo’s new version',
  startDraft: 'Start a draft from the new version',
  discardAndStart: 'Discard the draft and start',
  keep: 'Keep my version',
  draftExists: 'This template already has a draft. Discard it to start a draft from the new version.',
  draftStarted: (n: number): string => `Draft v${n} started from Aramo’s new version, with your logo. Re-apply your own wording, then preview and approve it.`,
  kept: 'You kept your version. We will tell you when Aramo publishes a newer one.',
  /** The compare side of the master. */
  masterSide: (n: number): string => `Aramo v${n}`,
  masterSideSub: 'Aramo’s new version',
  startFailed: 'Could not start a draft from the new version.',
  keepFailed: 'Could not keep your version.',
  compareFailed: 'Could not load Aramo’s new version.',
} as const;

/** The row badge for a template, from the server flags only (null: no badge). */
export function templateMasterBadge(master: TemplateMaster | null | undefined): string | null {
  if (master === null || master === undefined) return null;
  if (master.withdrawn !== null) return TEMPLATE_SYNC_COPY.badgeWithdrawn;
  return master.newer_available ? TEMPLATE_SYNC_COPY.badgeNewer : null;
}

/** How many templates the banner counts: those the server flags newer_available. */
export function templatesWithNewerMaster(items: ReadonlyArray<{ readonly master?: TemplateMaster | null }>): number {
  return items.filter((i) => i.master?.newer_available === true).length;
}

/** Whether the Studio shows the sync notice (newer version, or withdrawn). */
export function showsMasterNotice(master: TemplateMaster | null | undefined): master is TemplateMaster {
  return master !== null && master !== undefined && (master.newer_available || master.withdrawn !== null);
}
