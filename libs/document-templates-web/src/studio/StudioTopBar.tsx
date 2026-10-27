import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@aramo/fe-foundation';

import type { TemplateStudioCopy } from './data-source';
import type { Readiness } from './readiness';

// PLATFORM-UX-1 F-9 (handoff §10.3) — the Studio top bar (56px): breadcrumb ending in the
// template name ("← name" below 1200px), the mono version tag, the save status, the
// Edit | Preview mode, the readiness pill (8 mini segments ≥1200px; opens Checks),
// Compare, Save draft, Publish vN… (terracotta; 50% while not ready — clicking then opens
// Checks), the ⋯ menu and the host's account slot (TEMPLATE-STUDIO-1 S-0: the host renders
// its account menu; the Studio saves unsaved changes before the host leaves).

export type SaveState = 'saved' | 'unsaved' | 'saving';
export type StudioMode = 'edit' | 'preview' | 'version';

export interface StudioTopBarProps {
  readonly name: string;
  readonly versionTag: string;
  /** Edit the draft: the save status, Save draft and the autosave toggle. */
  readonly canEdit: boolean;
  /** Approve the draft: the approve button. */
  readonly canApprove: boolean;
  readonly copy: TemplateStudioCopy;
  readonly saveState: SaveState;
  readonly saveLabel: string;
  readonly mode: StudioMode;
  readonly onMode: (m: 'edit' | 'preview') => void;
  readonly readiness: Readiness;
  readonly wide: boolean;
  readonly onOpenChecks: () => void;
  readonly onCompare: () => void;
  readonly onSave: () => void;
  readonly dirty: boolean;
  readonly nextVersion: number;
  readonly onPublish: () => void;
  readonly canWithdraw: boolean;
  readonly canCancelWithdrawal: boolean;
  readonly onWithdraw: () => void;
  readonly onCancelWithdrawal: () => void;
  readonly autosave: boolean;
  readonly onToggleAutosave: () => void;
  readonly onShortcuts: () => void;
  /** The host's account menu (platform: AccountMenu). */
  readonly account?: ReactNode;
  // ── TEMPLATE-STUDIO-1 S-1/S-2 (optional; absent on the platform) ──
  /** Show Compare (default true; hidden in the tenant preview of an Aramo default). */
  readonly showCompare?: boolean;
  /** Show the Edit | Preview mode toggle (default true; hidden for an Aramo default). */
  readonly showModeToggle?: boolean;
  /** Show the readiness pill (default true; hidden for an Aramo default). */
  readonly showReadiness?: boolean;
  /** Discard the open draft (organization): a ⋯ menu item. */
  readonly onDiscard?: () => void;
  /** Host actions before the ⋯ menu (the gallery preview's Adopt). */
  readonly actions?: ReactNode;
}

export function StudioTopBar(p: StudioTopBarProps) {
  const [more, setMore] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!more) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setMore(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMore(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [more]);

  const r = p.readiness;
  const run = (fn: () => void) => () => {
    setMore(false);
    fn();
  };

  return (
    <header className="pws-top">
      <nav aria-label="Breadcrumb" className="pws-top__crumbs">
        {p.wide ? (
          <>
            {p.copy.crumbs.map((c) => (
              <Fragment key={c.label}>
                {c.to !== undefined ? (
                  <Link to={c.to} className="pws-top__crumb">
                    {c.label}
                  </Link>
                ) : (
                  <span className="pws-top__crumb">{c.label}</span>
                )}
                <span className="pws-top__sep" aria-hidden="true">
                  /
                </span>
              </Fragment>
            ))}
          </>
        ) : (
          <Link to={p.copy.back.to} className="pws-top__crumb" aria-label={p.copy.back.label}>
            ←
          </Link>
        )}
        <span aria-current="page" className="pws-top__name">
          {p.name}
        </span>
      </nav>
      <span className="pws-top__ver">{p.versionTag}</span>
      {p.canEdit ? (
        <span role="status" className="pws-top__save">
          <span className={`pws-top__dot pws-top__dot--${p.saveState}`} aria-hidden="true" />
          {p.saveLabel}
        </span>
      ) : null}
      <div className="pws-top__right">
        {p.showModeToggle !== false ? (
          <div role="group" aria-label="Mode" className="pws-seg">
            <Button
              unstyled
              aria-pressed={p.mode !== 'preview'}
              disabled={!p.canEdit}
              className={`pws-seg__item${p.mode !== 'preview' ? ' pws-seg__item--on' : ''}`}
              onClick={() => p.onMode('edit')}
            >
              Edit
            </Button>
            <Button unstyled aria-pressed={p.mode === 'preview'} className={`pws-seg__item${p.mode === 'preview' ? ' pws-seg__item--on' : ''}`} onClick={() => p.onMode('preview')}>
              Preview
            </Button>
          </div>
        ) : null}
        {p.showReadiness !== false ? (
          <Button unstyled className={`pws-ready${r.ready ? ' pws-ready--ok' : ''}`} title="Publishing checks" onClick={p.onOpenChecks}>
            {p.wide ? (
              <span className="pws-ready__segs" aria-hidden="true">
                {r.items.map((i) => (
                  <span key={i.id} className={`pws-ready__seg pws-ready__seg--${i.ok ? 'ok' : i.severity}`} />
                ))}
              </span>
            ) : null}
            {p.copy.readinessLabel(r, p.wide)}
          </Button>
        ) : null}
        {p.showCompare !== false ? (
          <Button unstyled className="pws-btn34" title="Compare versions" aria-label={p.wide ? undefined : 'Compare versions'} onClick={p.onCompare}>
            {p.wide ? 'Compare' : '⇄'}
          </Button>
        ) : null}
        {p.canEdit ? (
          <Button unstyled className="pws-btn34" title="Save draft (⌘S)" disabled={!p.dirty} onClick={p.onSave}>
            {p.wide ? 'Save draft' : 'Save'}
          </Button>
        ) : null}
        {p.canApprove ? (
          <Button
            unstyled
            className={`pws-btn34 pws-btn34--terra${r.ready ? '' : ' pws-btn34--dim'}`}
            title={p.copy.approveHint}
            aria-disabled={!r.ready}
            onClick={p.onPublish}
          >
            {p.copy.approveButton(p.nextVersion, p.wide)}
          </Button>
        ) : null}
        {p.actions}
        <div className="pws-more" ref={wrap}>
          <Button ref={trigger} unstyled className="pws-more__btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((m) => !m)}>
            ⋯
          </Button>
          {more ? (
            <div role="menu" aria-label="More actions" className="pws-more__menu">
              {p.canWithdraw ? (
                <Button unstyled role="menuitem" className="pws-more__item pws-more__item--wd" onClick={run(p.onWithdraw)}>
                  Withdraw template…
                </Button>
              ) : null}
              {p.canCancelWithdrawal ? (
                <Button unstyled role="menuitem" className="pws-more__item pws-more__item--strong" onClick={run(p.onCancelWithdrawal)}>
                  Cancel withdrawal…
                </Button>
              ) : null}
              {p.onDiscard !== undefined ? (
                <Button unstyled role="menuitem" className="pws-more__item pws-more__item--wd" onClick={run(p.onDiscard)}>
                  Discard draft…
                </Button>
              ) : null}
              {p.canEdit ? (
                <Button unstyled role="menuitem" className="pws-more__item" onClick={run(p.onToggleAutosave)}>
                  <span className="pws-more__grow">Autosave drafts</span>
                  <b>{p.autosave ? 'On' : 'Off'}</b>
                </Button>
              ) : null}
              <Button unstyled role="menuitem" className="pws-more__item" onClick={run(p.onShortcuts)}>
                <span className="pws-more__grow">Keyboard shortcuts</span>
                <span className="pws-more__kbd">?</span>
              </Button>
              <div role="menuitem" className="pws-more__off" aria-disabled="true" title="PDF download isn't available yet">
                Download as PDF
              </div>
            </div>
          ) : null}
        </div>
        {p.account}
      </div>
    </header>
  );
}
