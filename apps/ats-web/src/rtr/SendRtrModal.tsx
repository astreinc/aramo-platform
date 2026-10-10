import { useState } from 'react';
import { Button } from '@aramo/fe-foundation';

import type { RtrComposeBlock } from './rtr-api';

// DOC-TEMPLATE-ADMIN-RTR-1 (§2.7) — the recruiter Send Right to Represent modal, styled
// to the approved prototype (aramo-prototype/platform/Requisition Detail CRM.dc.html,
// #ws-rtr=modal). A 560px confirmation surface: read-only Talent / Client / Requisition,
// the GOVERNED template provenance (name · v{n}) with a lock + Preview document, the
// recipient locked to the talent record, and Send for signature. There is NO template
// selector, NO editable body or terms (the locked rulings). Fail-closed: a missing
// authoritative binding surfaces here and disables send — Aramo never substitutes a value.

const LockSvg = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#93A0A8" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

const L: React.CSSProperties = { fontSize: '10.5px', fontWeight: 700, letterSpacing: '.06em', color: '#93A0A8' };
const V: React.CSSProperties = { fontSize: '13px', fontWeight: 600, marginTop: 3 };

export function SendRtrModal({
  talentName,
  clientName,
  requisitionTitle,
  templateLine,
  recipientEmail,
  footNote,
  onPreview,
  onSend,
  onClose,
  composePreview = null,
  disabledText = null,
  sendDisabled = false,
}: {
  readonly talentName: string;
  readonly clientName: string | null;
  readonly requisitionTitle: string | null;
  readonly templateLine: string | null;
  readonly recipientEmail: string | null;
  readonly footNote: string;
  readonly onPreview: () => void;
  readonly onSend: () => Promise<{ ok: boolean; missingText?: string }>;
  readonly onClose: () => void;
  // SEAM 4 — the compose-driven pre-request flow: a real-bound preview rendered for
  // this (talent, requisition). When present, "Preview document" toggles this inline
  // preview (no presigned URL exists yet); otherwise it falls back to onPreview.
  readonly composePreview?: { readonly title: string; readonly blocks: readonly RtrComposeBlock[] } | null;
  // Fail-closed BEFORE send (e.g. composeRtr refused: no approved template / missing
  // binding). Shows the honest message and disables Send — Aramo never substitutes.
  readonly disabledText?: string | null;
  // Disable Send without a banner (e.g. while the compose read is still loading).
  readonly sendDisabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const send = async () => {
    setBusy(true);
    setMissing(null);
    try {
      const res = await onSend();
      if (!res.ok && res.missingText != null) setMissing(res.missingText);
    } finally {
      setBusy(false);
    }
  };
  const previewDoc = () => {
    if (composePreview != null) {
      setShowPreview((v) => !v);
      return;
    }
    onPreview();
  };
  const banner = missing ?? disabledText;
  const disabled = busy || banner != null || sendDisabled;

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,25,40,.45)', zIndex: 70 }} />
      <div
        role="dialog"
        aria-label="Send Right to Represent"
        data-testid="send-rtr-modal"
        style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 'min(560px,94vw)', maxHeight: '92vh', overflowY: 'auto', background: '#fff', borderRadius: 14, zIndex: 71, boxShadow: '0 24px 64px rgba(11,16,34,.32)', display: 'flex', flexDirection: 'column', fontFamily: "'Hanken Grotesk', system-ui, sans-serif", color: '#1B2730' }}
      >
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid #E5E9ED', display: 'flex', alignItems: 'center', gap: 11 }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, background: '#E8EDFB', color: '#011F8D', display: 'grid', placeItems: 'center', flex: 'none' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 15l2 2 4-4" /></svg>
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: 'block', fontSize: 16, fontWeight: 700, letterSpacing: '-.01em' }}>Send Right to Represent</span>
            <span style={{ display: 'block', fontSize: 12, color: '#5C6770', marginTop: 1 }}>The talent signs through a secure e-signature link</span>
          </span>
          <Button unstyled onClick={onClose} title="Close" style={{ width: 30, height: 30, border: 'none', borderRadius: 6, background: 'transparent', color: '#5C6770', cursor: 'pointer', fontSize: 17 }}>×</Button>
        </div>

        <div style={{ padding: '16px 22px 6px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12 }}>
            <div><div style={L}>TALENT</div><div style={V} data-testid="send-rtr-talent">{talentName}</div></div>
            <div><div style={L}>CLIENT</div><div style={V}>{clientName ?? '—'}</div></div>
            <div><div style={L}>REQUISITION</div><div style={V}>{requisitionTitle ?? '—'}</div></div>
          </div>

          <div>
            <div style={{ ...L, marginBottom: 6 }}>TEMPLATE</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, border: '1px solid #E5E9ED', background: '#FAFBFC', borderRadius: 10, padding: '10px 12px', flexWrap: 'wrap' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5C6770" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" /></svg>
              <span style={{ flex: '1 1 200px', minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700 }}>
                  {templateLine ?? 'Approved template'}<LockSvg />
                </span>
                <span style={{ display: 'block', fontSize: '11.5px', color: '#5C6770', marginTop: 1 }}>Approved by your organization</span>
              </span>
              <Button unstyled onClick={previewDoc} style={{ border: '1px solid #022AC0', background: '#fff', color: '#022AC0', borderRadius: 7, padding: '6px 12px', font: "600 12px 'Hanken Grotesk',sans-serif", cursor: 'pointer', whiteSpace: 'nowrap' }} data-testid="send-rtr-preview">Preview document</Button>
            </div>
            {composePreview != null && showPreview ? (
              <div
                data-testid="send-rtr-compose-preview"
                style={{ marginTop: 10, border: '1px solid #E5E9ED', background: '#fff', borderRadius: 10, padding: '14px 16px', maxHeight: 280, overflowY: 'auto' }}
              >
                <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '.04em', color: '#011F8D', marginBottom: 8 }}>
                  Preview of what {talentName} will receive · nothing has been sent
                </div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: '#1B2730', marginBottom: 6 }}>{composePreview.title}</div>
                {composePreview.blocks.map((b, i) =>
                  b.type === 'HEADING' ? (
                    <div key={i} style={{ fontSize: '13.5px', fontWeight: 700, color: '#1B2730', margin: '10px 0 4px' }}>{b.text}</div>
                  ) : (
                    <p key={i} style={{ fontSize: '12.5px', color: '#3A454E', lineHeight: 1.5, margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{b.text}</p>
                  ),
                )}
              </div>
            ) : null}
          </div>

          <div>
            <div style={{ ...L, marginBottom: 6 }}>RECIPIENT</div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: '1px solid #E5E9ED', background: '#FAFBFC', borderRadius: 16, padding: '4px 12px', fontSize: '12.5px' }} data-testid="send-rtr-recipient">
              {recipientEmail ?? 'No email on the talent record'}<LockSvg />
            </span>
            <div style={{ fontSize: '11.5px', color: '#93A0A8', marginTop: 5 }}>From the talent record · locked</div>
          </div>

          {banner != null ? (
            <div style={{ border: '1px solid #F2D3CB', background: '#FBE9E4', borderRadius: 9, padding: '9px 12px', fontSize: '12.5px', color: '#8E2F1E' }} role="alert" data-testid="send-rtr-missing">
              {banner}
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 22px 18px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11.5px', color: '#93A0A8', flex: '1 1 200px' }}>{footNote}</span>
          <Button unstyled onClick={onClose} style={{ border: '1px solid #D5DBE1', background: '#fff', color: '#1B2730', borderRadius: 8, padding: '9px 16px', font: "600 13px 'Hanken Grotesk',sans-serif", cursor: 'pointer' }}>Cancel</Button>
          <Button
            unstyled
            onClick={() => void send()}
            disabled={disabled}
            data-testid="send-rtr-send"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: `1px solid ${disabled ? '#E5E9ED' : '#022AC0'}`, background: disabled ? '#F4F6FA' : '#022AC0', color: disabled ? '#A9B3BC' : '#fff', borderRadius: 8, padding: '9px 17px', font: "600 13px 'Hanken Grotesk',sans-serif", cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></svg>
            {busy ? 'Sending…' : 'Send for signature'}
          </Button>
        </div>
      </div>
    </>
  );
}
