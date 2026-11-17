import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '@aramo/fe-foundation';

import { SIGNATURE_FONT_STACK, initialsOf, trimmedSignaturePng, typedSignaturePng } from '../../signature-image';
import { SAVED_MARK_FONT_KEY, errorMessage, savedMarksApi, type SavedMark, type SavedMarkTarget, type SavedMarks, type SignMeSettings } from '../api';
import { Btn, Check, ErrorBox, Field, TextIn, fmtDate } from '../ui';
import { useWorkspace } from '../workspace';

// UAT SIG-05 — Settings → Your default signature and initials: the web counterpart of
// the Aramo Sign app's Account → Default signature / Default initials (Sign Mobile
// M-A3 §4). View, add or replace (type or draw), and remove. The same defaults the app
// and the web signing page offer when signing (M-A15), and the M-A15 §5 opt-out for
// signing links emailed to the user.

const LABEL: Record<SavedMarkTarget, string> = { signature: 'Signature', initials: 'Initials' };

export function SavedSignatureSection() {
  const { ctx, toast } = useWorkspace();
  const [marks, setMarks] = useState<SavedMarks | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<SavedMarkTarget | null>(null);
  const [removing, setRemoving] = useState<SavedMarkTarget | null>(null);
  const [busy, setBusy] = useState(false);
  // M-A15 §5 — offer the saved signature on signing links sent to the user's email.
  const [settings, setSettings] = useState<SignMeSettings | null>(null);

  useEffect(() => {
    savedMarksApi.settings().then(
      (s) => setSettings(typeof s?.date_format === 'string' ? s : null),
      () => setSettings(null),
    );
  }, []);

  const setOffer = async (on: boolean) => {
    if (settings === null) return;
    const before = settings;
    setSettings({ ...settings, offer_saved_signature_on_links: on });
    try {
      await savedMarksApi.updateSettings({ offer_saved_signature_on_links: on });
    } catch (e) {
      setSettings(before);
      setError(errorMessage(e, 'Couldn’t save that setting. Try again.'));
    }
  };

  const load = useCallback(() => {
    setError('');
    savedMarksApi.get().then(
      // A missing entry (an older server) reads as nothing saved.
      (r) => setMarks({ signature: r?.signature ?? null, initials: r?.initials ?? null }),
      (e: unknown) => setError(errorMessage(e, 'Couldn’t load your saved signature.')),
    );
  }, []);
  useEffect(load, [load]);

  const remove = async (target: SavedMarkTarget) => {
    setBusy(true);
    try {
      await savedMarksApi.remove(target);
      setMarks((m) => (m === null ? m : { ...m, [target]: null }));
      setRemoving(null);
      toast(target === 'signature' ? 'Default signature removed' : 'Default initials removed');
    } catch (e) {
      setError(errorMessage(e, 'Couldn’t remove it. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sg-card" data-testid="settings-saved-signature">
      <div className="sg-card__head">
        Your default signature and initials <span className="sg-tag sg-tag--blue">Sign only</span>
      </div>
      <div className="sg-card__body">
        {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
        {marks === null && error === '' ? <p className="sg-muted">Loading…</p> : null}
        {marks !== null
          ? (['signature', 'initials'] as const).map((target) => (
              <MarkRow
                key={target}
                target={target}
                mark={marks[target]}
                busy={busy}
                onEdit={() => setEditing(target)}
                onRemove={() => setRemoving(target)}
              />
            ))
          : null}
        <p className="sg-help" style={{ marginTop: 12 }}>
          Offered when you sign, so you don’t draw or type it each time. You can always use a different one when signing.
        </p>
        {settings !== null ? (
          <label className="sg-settings-row" data-testid="offer-on-links">
            <Check checked={settings.offer_saved_signature_on_links !== false} onChange={(e) => void setOffer(e.target.checked)} />
            <span>Also offer it on signing links emailed to {ctx.user.email ?? 'my email address'}</span>
          </label>
        ) : null}
      </div>
      {editing !== null ? (
        <MarkDialog
          target={editing}
          suggestedName={ctx.user.display_name ?? ''}
          onClose={() => setEditing(null)}
          onSaved={(m) => {
            setMarks((cur) => ({ signature: cur?.signature ?? null, initials: cur?.initials ?? null, [editing]: m }));
            toast(editing === 'signature' ? 'Default signature saved' : 'Default initials saved');
            setEditing(null);
          }}
        />
      ) : null}
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => {
          if (!o) setRemoving(null);
        }}
        title={removing === 'initials' ? 'Remove your default initials?' : 'Remove your default signature?'}
        description="Documents you already signed keep their signature. You’ll create a new one the next time you sign."
        size="sm"
        footer={
          <>
            <Btn onClick={() => setRemoving(null)}>Keep it</Btn>
            <Btn variant="danger" disabled={busy} onClick={() => removing !== null && void remove(removing)} data-testid="confirm-remove-mark">
              Remove
            </Btn>
          </>
        }
      >
        {null}
      </Dialog>
    </section>
  );
}

function MarkRow({
  target,
  mark,
  busy,
  onEdit,
  onRemove,
}: {
  target: SavedMarkTarget;
  mark: SavedMark | null;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="sg-settings-row" data-testid={`saved-${target}`} style={{ alignItems: 'center', gap: 16 }}>
      <div style={{ minWidth: 90, fontWeight: 600 }}>{LABEL[target]}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {mark === null ? (
          <span className="sg-muted">None saved</span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <img
              src={mark.image_data_url}
              alt={`Your default ${target}`}
              style={{ maxHeight: 48, maxWidth: 220, background: '#fff', border: '1px solid var(--line)', borderRadius: 6, padding: 4 }}
            />
            <span className="sg-muted" style={{ fontSize: 12.5 }}>
              {mark.kind === 'TYPED' ? 'Typed' : 'Drawn'} · saved {fmtDate(mark.updated_at)}
            </span>
          </span>
        )}
      </div>
      <Btn onClick={onEdit} disabled={busy} data-testid={`edit-${target}`}>
        {mark === null ? 'Add' : 'Replace'}
      </Btn>
      {mark !== null ? (
        <Btn variant="ghost" onClick={onRemove} disabled={busy} data-testid={`remove-${target}`}>
          Remove
        </Btn>
      ) : null}
    </div>
  );
}

function MarkDialog({
  target,
  suggestedName,
  onClose,
  onSaved,
}: {
  target: SavedMarkTarget;
  suggestedName: string;
  onClose: () => void;
  onSaved: (m: SavedMark) => void;
}) {
  const [tab, setTab] = useState<'TYPED' | 'DRAWN'>('TYPED');
  // As in the app: the full name is typed (and stored as typed_name); initials are derived.
  const [typed, setTyped] = useState(suggestedName);
  const [drawn, setDrawn] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const label = target === 'initials' ? 'initials' : 'signature';

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (c === null) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = canvasRef.current?.getContext('2d');
    if (!g) return;
    drawing.current = true;
    g.lineWidth = 2.4;
    g.lineCap = 'round';
    g.strokeStyle = '#151A22';
    const p = point(e);
    g.beginPath();
    g.moveTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const g = canvasRef.current?.getContext('2d');
    if (!g) return;
    const p = point(e);
    g.lineTo(p.x, p.y);
    g.stroke();
    setDrawn(true);
  };
  const end = () => {
    drawing.current = false;
  };
  const clear = () => {
    const c = canvasRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setDrawn(false);
  };

  const shown = target === 'initials' ? initialsOf(typed) : typed.trim();
  const ready = tab === 'TYPED' ? shown.length > 0 : drawn;
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const name = typed.trim().slice(0, 100);
      const body =
        tab === 'TYPED'
          ? { kind: 'TYPED' as const, typed_name: name, font_key: SAVED_MARK_FONT_KEY, image_data_url: await typedSignaturePng(target === 'initials' ? initialsOf(name) : name) }
          : { kind: 'DRAWN' as const, image_data_url: canvasRef.current ? trimmedSignaturePng(canvasRef.current) : '' };
      onSaved(await savedMarksApi.put(target, body));
    } catch (e) {
      setError(errorMessage(e, `Couldn’t save your ${label}. Try again.`));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={target === 'initials' ? 'Your default initials' : 'Your default signature'}
      size="md"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={!ready || saving} onClick={() => void save()} data-testid="save-mark">
            {saving ? 'Saving…' : 'Save'}
          </Btn>
        </>
      }
    >
      <div className="sg-tabs" role="tablist" aria-label={`How to create your ${label}`}>
        <Btn variant="ghost" role="tab" aria-selected={tab === 'TYPED'} className={`sg-tab${tab === 'TYPED' ? ' sg-tab--on' : ''}`} onClick={() => setTab('TYPED')}>
          Type
        </Btn>
        <Btn variant="ghost" role="tab" aria-selected={tab === 'DRAWN'} className={`sg-tab${tab === 'DRAWN' ? ' sg-tab--on' : ''}`} onClick={() => setTab('DRAWN')}>
          Draw
        </Btn>
      </div>
      {tab === 'TYPED' ? (
        <>
          <Field label="Your full name" htmlFor="mark-typed">
            <TextIn id="mark-typed" value={typed} maxLength={100} onChange={(e) => setTyped(e.target.value)} data-testid="mark-typed" />
          </Field>
          <div
            aria-label={`${label} preview`}
            style={{ minHeight: 72, border: '1px solid var(--line)', borderRadius: 10, display: 'flex', alignItems: 'center', padding: '0 16px', fontFamily: SIGNATURE_FONT_STACK, fontSize: 30, marginTop: 12 }}
          >
            {shown || <span className="sg-muted" style={{ fontFamily: 'inherit', fontSize: 14 }}>Preview</span>}
          </div>
        </>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            width={560}
            height={160}
            tabIndex={0}
            aria-label={`Draw your ${label}`}
            data-testid="mark-pad"
            style={{ width: '100%', height: 160, border: '1px dashed var(--line)', borderRadius: 10, touchAction: 'none', background: '#fff', display: 'block' }}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
          />
          <p className="sg-help">Drawing has no keyboard equivalent — use Type instead if you prefer.</p>
          <Btn variant="ghost" onClick={clear}>
            Clear
          </Btn>
        </>
      )}
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
    </Dialog>
  );
}
