import { Button } from '../../ui';

// CSP PA-7 — the shared editor/detail header matching the prototype: a back link
// (‹ Policies), the title + subtitle, and the Source legend (Inherited / Client
// override / Client-added). `legend` is hidden on read-only detail views that don't
// need it.
export function PolicyEditorHeader({
  onBack,
  title,
  subtitle,
  legend = true,
}: {
  onBack: () => void;
  title: string;
  subtitle: string;
  legend?: boolean;
}): JSX.Element {
  return (
    <>
      <Button unstyled className="rc-pol-back" onClick={onBack}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Policies
      </Button>
      <div className="rc-pol__head">
        <div className="rc-pol__headmain">
          <div className="rc-pol__title">{title}</div>
          <div className="rc-pol__subtitle">{subtitle}</div>
        </div>
        {legend ? (
          <span className="rc-pol__legend">
            <span className="rc-pol__legend-lbl">Source:</span>
            <span className="rc-pol-lgd rc-pol-lgd--tenant">Inherited from tenant</span>
            <span className="rc-pol-lgd rc-pol-lgd--override">Client override</span>
            <span className="rc-pol-lgd rc-pol-lgd--added">Client-added</span>
          </span>
        ) : null}
      </div>
    </>
  );
}
