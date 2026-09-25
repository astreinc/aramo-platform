import { useRef, useState } from 'react';

import { signApi, type SignerSession } from './sign-api.js';

// DOC-4 (R-4-8) — the signer journey (§333): open secure link -> exchange token
// -> accept disclosure -> apply signature (typed or drawn) -> complete -> receipt.
// A signer cannot complete without a signature value. Tenant is resolved
// server-side from the capability token; nothing here sends a tenant id.

type Stage = 'OPEN' | 'DISCLOSURE' | 'SIGN' | 'DONE' | 'ERROR';

const DISCLOSURE_VERSION = 'v1';
// The frozen disclosure text hash the signer acknowledges (mirrors the backend's
// SignerDisclosureAcceptance record; a real deployment ships the disclosure text).
const DISCLOSURE_TEXT_HASH = 'doc4-esign-disclosure-v1';

function tokenFromLocation(): string {
  const m = /\/s\/([^/?#]+)/.exec(window.location.pathname);
  if (m !== null && m[1] !== undefined) return decodeURIComponent(m[1]);
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

export function App(): JSX.Element {
  const [token] = useState<string>(tokenFromLocation);
  const [fieldId, setFieldId] = useState<string>(new URLSearchParams(window.location.search).get('field') ?? '');
  const [stage, setStage] = useState<Stage>('OPEN');
  const [session, setSession] = useState<SignerSession | null>(null);
  const [error, setError] = useState<string>('');
  const [method, setMethod] = useState<'TYPED' | 'DRAWN'>('TYPED');
  const [typed, setTyped] = useState<string>('');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<boolean>(false);

  const fail = (e: unknown): void => {
    setError(e instanceof Error ? e.message : String(e));
    setStage('ERROR');
  };

  const open = async (): Promise<void> => {
    try {
      const s = await signApi.exchange(token);
      setSession(s);
      setStage('DISCLOSURE');
    } catch (e) {
      fail(e);
    }
  };

  const accept = async (): Promise<void> => {
    try {
      await signApi.acceptDisclosure(token, DISCLOSURE_VERSION, DISCLOSURE_TEXT_HASH);
      setStage('SIGN');
    } catch (e) {
      fail(e);
    }
  };

  const signatureValue = (): string => {
    if (method === 'TYPED') return typed.trim();
    const canvas = canvasRef.current;
    return canvas === null ? '' : canvas.toDataURL('image/png');
  };

  const apply = async (): Promise<void> => {
    const value = signatureValue();
    if (value.length === 0) {
      setError('A signature is required before completing.');
      return;
    }
    try {
      await signApi.fillField(token, fieldId, value, method);
      const res = await signApi.complete(token);
      if (res.envelope_status === 'COMPLETED' || res.envelope_status === 'IN_PROGRESS') setStage('DONE');
    } catch (e) {
      fail(e);
    }
  };

  const startDraw = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    drawing.current = true;
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    }
  };
  const moveDraw = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      ctx.lineTo(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
      ctx.stroke();
    }
  };
  const endDraw = (): void => {
    drawing.current = false;
  };

  return (
    <main className="sign-shell">
      <h1>Aramo — Electronic Signature</h1>
      {stage === 'OPEN' && (
        <section>
          <p>You have a document to review and sign.</p>
          {/* eslint-disable-next-line no-restricted-syntax -- sign-web is the isolated external-signer SPA (scope:sign, R-4-2) with no design-system dependency by design; native controls are a genuine native need (G1 escape hatch). */}
          <button type="button" onClick={() => void open()} disabled={token.length === 0}>
            Open document
          </button>
          {token.length === 0 && <p className="hint">This link is missing its signing token.</p>}
        </section>
      )}
      {stage === 'DISCLOSURE' && (
        <section>
          <h2>Electronic Record & Signature Disclosure</h2>
          <p>By continuing you consent to sign this document electronically.</p>
          {/* eslint-disable-next-line no-restricted-syntax -- sign-web native control (isolated signer SPA, no design-system dep). */}
          <button type="button" onClick={() => void accept()}>I agree</button>
        </section>
      )}
      {stage === 'SIGN' && (
        <section>
          <h2>Apply your signature</h2>
          <label>
            Field id
            {/* eslint-disable-next-line no-restricted-syntax -- sign-web native control (isolated signer SPA, no design-system dep). */}
            <input value={fieldId} onChange={(e) => setFieldId(e.target.value)} placeholder="signature field id" />
          </label>
          <div className="method">
            {/* eslint-disable-next-line no-restricted-syntax -- native radio: no fe-foundation Radio primitive exists; isolated signer SPA. */}
            <label><input type="radio" checked={method === 'TYPED'} onChange={() => setMethod('TYPED')} /> Type</label>
            {/* eslint-disable-next-line no-restricted-syntax -- native radio: no fe-foundation Radio primitive exists; isolated signer SPA. */}
            <label><input type="radio" checked={method === 'DRAWN'} onChange={() => setMethod('DRAWN')} /> Draw</label>
          </div>
          {method === 'TYPED' ? (
            // eslint-disable-next-line no-restricted-syntax -- sign-web native control (isolated signer SPA, no design-system dep).
            <input aria-label="typed signature" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Full name" />
          ) : (
            <canvas
              ref={canvasRef}
              width={320}
              height={120}
              className="pad"
              onPointerDown={startDraw}
              onPointerMove={moveDraw}
              onPointerUp={endDraw}
              onPointerLeave={endDraw}
            />
          )}
          {/* eslint-disable-next-line no-restricted-syntax -- sign-web native control (isolated signer SPA, no design-system dep). */}
          <button type="button" onClick={() => void apply()}>Apply signature & complete</button>
          {error.length > 0 && <p className="err">{error}</p>}
        </section>
      )}
      {stage === 'DONE' && (
        <section>
          <h2>Signed</h2>
          <p>Thank you — your signature has been recorded{session ? ` (envelope ${session.envelope_id}).` : '.'}</p>
        </section>
      )}
      {stage === 'ERROR' && (
        <section>
          <h2>Something went wrong</h2>
          <p className="err">{error}</p>
        </section>
      )}
    </main>
  );
}
