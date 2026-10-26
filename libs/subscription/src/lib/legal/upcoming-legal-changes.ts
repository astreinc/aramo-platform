import { calendarDaysUntil, describeLegalChange, legalChangeAudience, parseCalendarDate } from './legal-change-notice.template.js';
import { LEGAL_DOCUMENTS, legalVersionStatus, systemLegalClock, type LegalClock, type LegalDocumentKey, type LegalDocumentVersion } from './legal-documents.js';

// Privacy Notice 1.1 remediation E-6 — the in-service notice (the Sign workspace banner) of an
// upcoming legal-document version with a future effective date.
//
// The banner reads ONE small interface, UpcomingLegalChangeSource. The default source is the
// governed list below (empty: nothing is announced until a reviewed change adds an entry). The
// future-effective legal-version resolver (E-5, PR-B) is meant to provide this interface
// instead, bound to the UPCOMING_LEGAL_CHANGE_SOURCE token, so the banner follows the registry's
// "published and upcoming" state without a second source of truth. This file does not resolve
// legal versions itself.

export interface UpcomingLegalChange {
  key: LegalDocumentKey;
  version: string;
  // YYYY-MM-DD, the first day the new version applies.
  effective_date: string;
}

export interface UpcomingLegalChangeSource {
  /** Every announced change (past and future); the caller filters by date. */
  announced(): readonly UpcomingLegalChange[];
}

export const UPCOMING_LEGAL_CHANGE_SOURCE = 'UPCOMING_LEGAL_CHANGE_SOURCE';

/**
 * The governed list of announced changes. Adding an entry shows the banner to account holders
 * until the effective date; it is a reviewed change, like the legal registry itself.
 */
export const UPCOMING_LEGAL_CHANGES: readonly UpcomingLegalChange[] = [];

export class StaticUpcomingLegalChangeSource implements UpcomingLegalChangeSource {
  constructor(private readonly list: readonly UpcomingLegalChange[] = UPCOMING_LEGAL_CHANGES) {}

  announced(): readonly UpcomingLegalChange[] {
    return this.list;
  }
}

/**
 * E-5 binding: the registry's "published and upcoming" versions (APPROVED, public URL,
 * effective_from in the future — legalVersionStatus === 'upcoming') announced as changes, merged
 * with the governed static list (registry entry wins on the same key + version). One source of
 * truth: scheduling a version in the registry is what makes the banner appear.
 */
export class RegistryUpcomingLegalChangeSource implements UpcomingLegalChangeSource {
  constructor(
    private readonly registry: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS,
    private readonly clock: LegalClock = systemLegalClock,
    private readonly extra: readonly UpcomingLegalChange[] = UPCOMING_LEGAL_CHANGES,
  ) {}

  announced(): readonly UpcomingLegalChange[] {
    const now = this.clock();
    const out = new Map<string, UpcomingLegalChange>();
    for (const c of this.extra) out.set(`${c.key}@${c.version}`, c);
    for (const d of this.registry) {
      const st = legalVersionStatus(d, this.registry, now);
      if (st.state !== 'upcoming' || st.effective_from === null) continue;
      out.set(`${d.key}@${d.version}`, { key: d.key, version: d.version, effective_date: st.effective_from.toISOString().slice(0, 10) });
    }
    return [...out.values()];
  }
}

export interface UpcomingLegalNotice {
  key: LegalDocumentKey;
  title: string;
  version: string;
  effective_date: string;
  url: string;
  current_version: string;
  current_url: string;
}

/**
 * The announced changes that are still upcoming on `now`'s UTC date and concern this tenant kind
 * (a Personal-only document is not shown to a Business account). An entry that does not describe
 * a real change (unknown key, no current version, malformed date) is skipped, never shown.
 */
export function upcomingLegalNotices(
  source: UpcomingLegalChangeSource,
  tenant_kind: string,
  now: Date,
  registry: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS,
): UpcomingLegalNotice[] {
  const out: UpcomingLegalNotice[] = [];
  for (const c of source.announced()) {
    const effective = parseCalendarDate(c.effective_date);
    if (effective === null || calendarDaysUntil(effective, now) <= 0) continue;
    if (legalChangeAudience(c.key) === 'PERSONAL' && tenant_kind !== 'PERSONAL') continue;
    let links;
    try {
      links = describeLegalChange(c.key, c.version, registry);
    } catch {
      continue;
    }
    out.push({
      key: links.key,
      title: links.title,
      version: links.version,
      effective_date: c.effective_date,
      url: links.upcoming_url,
      current_version: links.current.version,
      current_url: links.current_url,
    });
  }
  return out;
}
