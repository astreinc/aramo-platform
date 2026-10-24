import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@aramo/fe-foundation';

import type { OperatorIdentity } from '../../identity/identity';
import { AccountMenu } from '../../shell/AccountMenu';

import type { Readiness } from './readiness';
import { readinessLabel } from './readiness';

// PLATFORM-UX-1 F-9 (handoff §10.3) — the Studio top bar (56px): breadcrumb ending in the
// template name ("← name" below 1200px), the mono version tag, the save status, the
// Edit | Preview mode, the readiness pill (8 mini segments ≥1200px; opens Checks),
// Compare, Save draft, Publish vN… (terracotta; 50% while not ready — clicking then opens
// Checks), the ⋯ menu and the account menu (which saves unsaved changes before leaving).

export type SaveState = 'saved' | 'unsaved' | 'saving';
export type StudioMode = 'edit' | 'preview' | 'version';

export interface StudioTopBarProps {
  readonly name: string;
  readonly versionTag: string;
  readonly canManage: boolean;
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
  readonly identity: OperatorIdentity;
  readonly onSwitchAccount: () => void;
  readonly onSignOut: () => void;
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
            <span className="pws-top__crumb">Documents</span>
            <span className="pws-top__sep" aria-hidden="true">
              /
            </span>
            <Link to="/document-templates" className="pws-top__crumb">
              Document templates
            </Link>
            <span className="pws-top__sep" aria-hidden="true">
              /
            </span>
          </>
        ) : (
          <Link to="/document-templates" className="pws-top__crumb" aria-label="Back to templates">
            ←
          </Link>
        )}
        <span aria-current="page" className="pws-top__name">
          {p.name}
        </span>
      </nav>
      <span className="pws-top__ver">{p.versionTag}</span>
      {p.canManage ? (
        <span role="status" className="pws-top__save">
          <span className={`pws-top__dot pws-top__dot--${p.saveState}`} aria-hidden="true" />
          {p.saveLabel}
        </span>
      ) : null}
      <div className="pws-top__right">
        <div role="group" aria-label="Mode" className="pws-seg">
          <Button
            unstyled
            aria-pressed={p.mode !== 'preview'}
            disabled={!p.canManage}
            className={`pws-seg__item${p.mode !== 'preview' ? ' pws-seg__item--on' : ''}`}
            onClick={() => p.onMode('edit')}
          >
            Edit
          </Button>
          <Button unstyled aria-pressed={p.mode === 'preview'} className={`pws-seg__item${p.mode === 'preview' ? ' pws-seg__item--on' : ''}`} onClick={() => p.onMode('preview')}>
            Preview
          </Button>
        </div>
        <Button unstyled className={`pws-ready${r.ready ? ' pws-ready--ok' : ''}`} title="Publishing checks" onClick={p.onOpenChecks}>
          {p.wide ? (
            <span className="pws-ready__segs" aria-hidden="true">
              {r.items.map((i) => (
                <span key={i.id} className={`pws-ready__seg pws-ready__seg--${i.ok ? 'ok' : i.severity}`} />
              ))}
            </span>
          ) : null}
          {readinessLabel(r, p.wide)}
        </Button>
        <Button unstyled className="pws-btn34" title="Compare versions" aria-label={p.wide ? undefined : 'Compare versions'} onClick={p.onCompare}>
          {p.wide ? 'Compare' : '⇄'}
        </Button>
        {p.canManage ? (
          <>
            <Button unstyled className="pws-btn34" title="Save draft (⌘S)" disabled={!p.dirty} onClick={p.onSave}>
              {p.wide ? 'Save draft' : 'Save'}
            </Button>
            <Button
              unstyled
              className={`pws-btn34 pws-btn34--terra${r.ready ? '' : ' pws-btn34--dim'}`}
              title="Publish requires every check to pass"
              aria-disabled={!r.ready}
              onClick={p.onPublish}
            >
              Publish {`v${p.nextVersion}`}…
            </Button>
          </>
        ) : null}
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
              {p.canManage ? (
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
        <AccountMenu
          identity={p.identity}
          onSwitchAccount={p.onSwitchAccount}
          onSignOut={p.onSignOut}
          notice={p.dirty ? "You have unsaved changes. They're saved before you sign out." : undefined}
        />
      </div>
    </header>
  );
}
