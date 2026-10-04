import { useCallback, useState } from 'react';

// Shared List|Board view preference for the requisition's talent surface. One
// preference is used by BOTH the Talent tab and the Workspace → Talent in play,
// so switching in either place agrees (they are sibling children of
// RequisitionDetailView, so lifting the state there keeps them live-synced), and
// the choice persists per user. The approved default is Board.
const KEY = 'aramo.req.talentView.v2';
export type TalentView = 'list' | 'board';

function readPref(): TalentView {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'list' || v === 'board' ? v : 'board';
  } catch {
    return 'board';
  }
}

export function useTalentViewPreference(): readonly [TalentView, (next: TalentView) => void] {
  const [view, setView] = useState<TalentView>(readPref);
  const set = useCallback((next: TalentView) => {
    setView(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* preference is best-effort; an unavailable store just means no persistence */
    }
  }, []);
  return [view, set] as const;
}
