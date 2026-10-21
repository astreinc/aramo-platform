import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@aramo/fe-foundation';

import { errorMessage, inboxApi } from '../api';
import { useWorkspace } from '../workspace';

// Dashboard welcome banner — design authority `platform/sign/Aramo Sign Workspace.dc.html`
// route #/app, `data-screen-label="Dashboard banner"` (handoff "Aramo Sign - dashboard
// banner"). A welcome line plus four quick actions; the KPI cards and the rest of the
// Dashboard stay below it.

const ICON = {
  template: 'M4 4h16v16H4zM4 9h16M9 9v11',
  sign: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4',
  send: 'M4 4l16 8-16 8 3-8zM7 12h13',
};

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function DashboardBanner() {
  const { ctx, base, toast } = useWorkspace();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const startRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const name = (ctx.user.display_name ?? '').trim();
  // Templates are only routed in an organization workspace (App.tsx Gate).
  const templates = ctx.workspace === 'sign';
  const newEnvelope = `${base}/envelopes/new`;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) startRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The first envelope waiting for THIS user's signature, opened through the
  // recipient-only signing link (inbox S-7); with none, the "Waiting for me" inbox.
  const signDocument = async () => {
    setOpen(false);
    try {
      const { waiting } = await inboxApi.list();
      const next = waiting.find((i) => i.can_sign);
      if (next !== undefined) {
        window.location.assign((await inboxApi.sign(next.id)).signing_url);
        return;
      }
    } catch (e) {
      toast(errorMessage(e));
    }
    navigate(`${base}/inbox`);
  };

  const sendAction = (cls: string, children: ReactNode, role?: 'menuitem') =>
    ctx.can_send ? (
      <Link role={role} className={cls} to={newEnvelope} onClick={() => setOpen(false)}>
        {children}
      </Link>
    ) : (
      <span role={role} className={`${cls} sg-banner--off`} aria-disabled="true" title="You don’t have permission to send envelopes">
        {children}
      </span>
    );

  return (
    <div className="sg-banner" data-screen-label="Dashboard banner" data-testid="dashboard-banner">
      <h1 className="sg-banner__h">{name !== '' ? `Welcome back, ${name}` : 'Welcome back'}</h1>
      <div className="sg-banner__row">
        <span className="sg-banner__start">
          <Button unstyled
            ref={startRef}
            type="button"
            className="sg-banner__btn sg-banner__btn--start"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            Start
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </Button>
          {open ? (
            <>
              <div className="sg-banner__scrim" onClick={() => close(false)} data-testid="start-scrim" />
              <div className="sg-banner__menu" role="menu" aria-label="Start" ref={menuRef}>
                {sendAction(
                  'sg-banner__item',
                  <>
                    Upload a document<span className="sg-banner__desc">Start a new envelope from a file</span>
                  </>,
                  'menuitem',
                )}
                {templates ? (
                  <Link role="menuitem" className="sg-banner__item" to={`${base}/templates`} onClick={() => setOpen(false)}>
                    Use a template<span className="sg-banner__desc">Saved documents, recipients and fields</span>
                  </Link>
                ) : null}
                <Button unstyled type="button" role="menuitem" className="sg-banner__item" onClick={() => void signDocument()}>
                  Sign a document<span className="sg-banner__desc">Envelopes waiting for your signature</span>
                </Button>
                {sendAction(
                  'sg-banner__item',
                  <>
                    Get signatures<span className="sg-banner__desc">Send a document to others to sign</span>
                  </>,
                  'menuitem',
                )}
              </div>
            </>
          ) : null}
        </span>
        {templates ? (
          <Link className="sg-banner__btn" to={`${base}/templates`}>
            <Icon d={ICON.template} />
            Use Envelope Template
          </Link>
        ) : null}
        <Button unstyled type="button" className="sg-banner__btn" onClick={() => void signDocument()}>
          <Icon d={ICON.sign} />
          Sign Document
        </Button>
        {sendAction(
          'sg-banner__btn',
          <>
            <Icon d={ICON.send} />
            Get Signatures
          </>,
        )}
      </div>
    </div>
  );
}
