import { relativeDate } from '../talent-workspace';
import type { TalentRecordView } from '../types';

// CRM-4 — the "Last contacted" cell (Talent list + Lists detail). Two lines:
// relative date + "Channel · Actor". null ⇒ "Never" (amber, no line 2 — NEVER a
// provenance string like "Imported"/"Added by"; those are not contacts, §8).
// Actor resolved from the roster the page already loaded; the current user → "you".
export function LastContactCell({
  last,
  userNames,
  myId,
}: {
  readonly last: TalentRecordView['last_contact'];
  readonly userNames: Record<string, string>;
  readonly myId: string | null;
}) {
  if (last === null || last === undefined) {
    return (
      <span className="rc-lastc rc-lastc--never">
        <span className="rc-lastc__d">Never</span>
      </span>
    );
  }
  const actor =
    last.actor_id === null
      ? '—'
      : last.actor_id === myId
        ? 'you'
        : (userNames[last.actor_id] ?? '—');
  const rel = relativeDate(last.occurred_at);
  const stale = /month|year|Never/.test(rel);
  return (
    <span className={`rc-lastc${stale ? ' rc-lastc--stale' : ''}`}>
      <span className="rc-lastc__d">{rel}</span>
      <span className="rc-lastc__m">
        {last.channel} · {actor}
      </span>
    </span>
  );
}
