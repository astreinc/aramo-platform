// Talent 360 — Documents (§8B): one list, a viewer and an upload dialog, all
// over EXISTING endpoints (frontend only).
//
// Sources (each row from exactly one):
//   • Resumes  — the resume-edition read (GET /talent-records/:id/resume-editions):
//     file name, upload date, the explicit default (= "Current"), the requisition a
//     revision was tailored for. Archived revisions are not listed.
//   • Everything else (RTR, offer, other governed documents) — the composed
//     Talent 360 `documents.key_documents`, MINUS its resume rows: those are
//     minted EXECUTED (so they would read as "signed") and archived editions stay
//     listed there — the resume-edition read is the authority for resumes.
// Upload adds a resume revision through the same chain as Edit talent
// (upload-url → storage PUT → attachment → edition). Non-resume uploads, the
// e-sign envelope/signer/certificate, the submitted-to record and document
// activity events have no endpoint yet — hidden, not invented.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Dialog, DialogClose, InlineAlert, Select } from '@aramo/fe-foundation';

import {
  createAttachment,
  createTalentResumeEdition,
  getAttachmentDownloadUrl,
  listTalentAttachments,
  listTalentResumeEditions,
  requestResumeUploadUrl,
  setTalentResumeEditionDefault,
} from '../talent/talent-api';
import type { AttachmentView, TalentResumeEditionView } from '../talent/types';
import { Button, LoadingState, safeErrorMessage } from '../ui';
import { resolveUserNames } from '../users/users-api';

import { ICON, shortDate } from './t360-model';
import { Glyph } from './t360-sections';
import { getTalent360DocumentContent } from './talent-360-api';
import type { Talent360View as Model, TalentDocumentView } from './talent-360-types';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,.doc,.docx';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const RESUME_KIND = /r[ée]sum[ée]/i;

type Tone = 'resume' | 'rtr' | 'other';
type RowSource = { kind: 'edition'; ed: TalentResumeEditionView } | { kind: 'doc'; d: TalentDocumentView };

interface DocRowModel {
  readonly key: string;
  readonly tone: Tone;
  readonly kind: string;
  readonly reqLabel: string | null;
  readonly current: boolean;
  readonly justUploaded: boolean;
  readonly line2: string;
  readonly action: 'Preview' | 'View';
  readonly source: RowSource;
}

interface ReqInfo {
  readonly code: string;
  readonly client: string | null;
  readonly role: string | null;
}

function fileSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const isTailored = (e: TalentResumeEditionView): boolean => e.requisition_id !== null || e.purpose === 'REQUISITION';

export function DocumentsSection({
  model,
  talentId,
  canEdit,
  notify,
}: {
  model: Model;
  talentId: string;
  canEdit: boolean;
  notify?: (msg: string) => void;
}): JSX.Element {
  const [editions, setEditions] = useState<readonly TalentResumeEditionView[] | null>(null);
  const [attachments, setAttachments] = useState<ReadonlyMap<string, AttachmentView>>(new Map());
  const [names, setNames] = useState<Record<string, string>>({});
  const [justUploaded, setJustUploaded] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<DocRowModel | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const reqs = useMemo(() => {
    const m = new Map<string, ReqInfo>();
    for (const o of [...(model.opportunities?.active ?? []), ...(model.opportunities?.closed ?? [])]) {
      m.set(o.requisition_id, { code: o.requisition_code, client: o.client_name, role: o.role_title });
    }
    return m;
  }, [model.opportunities]);

  const load = useCallback((): Promise<void> => {
    const eds = listTalentResumeEditions(talentId)
      .then((r) => setEditions(r.editions ?? []))
      .catch(() => setEditions([]));
    // Size + uploader come from the backing attachment (best-effort).
    const atts = listTalentAttachments(talentId)
      .then((r) => {
        const items = r.items ?? [];
        setAttachments(new Map(items.map((a) => [a.id, a])));
        const ids = [...new Set(items.map((a) => a.uploaded_by_id).filter((x): x is string => x !== null))];
        if (ids.length > 0) void resolveUserNames(ids).then(setNames).catch(() => undefined);
      })
      .catch(() => undefined);
    return Promise.all([eds, atts]).then(() => undefined);
  }, [talentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (model.documents === null && editions !== null && editions.length === 0) {
    return (
      <div className="t360-card t360-card--sect">
        <div className="t360-sect__title">Documents</div>
        <div className="t360-empty">You don’t have access to this section.</div>
      </div>
    );
  }

  const rows: DocRowModel[] = [];
  const active = (editions ?? []).filter((e) => e.lifecycle_status === 'active');
  const ordered = [...active].sort((a, b) => {
    const ja = justUploaded.has(a.edition_id) ? 1 : 0;
    const jb = justUploaded.has(b.edition_id) ? 1 : 0;
    if (ja !== jb) return jb - ja;
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    const ta = isTailored(a) ? 1 : 0;
    const tb = isTailored(b) ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return b.uploaded_at.localeCompare(a.uploaded_at);
  });
  for (const e of ordered) {
    const tailored = isTailored(e);
    const req = e.requisition_id !== null ? (reqs.get(e.requisition_id) ?? null) : null;
    const when = shortDate(e.uploaded_at);
    rows.push({
      key: `ed:${e.edition_id}`,
      tone: 'resume',
      kind: tailored ? 'Resume · tailored' : 'Resume',
      reqLabel: req?.code ?? null,
      current: e.is_default,
      justUploaded: justUploaded.has(e.edition_id),
      line2: [e.filename, e.is_default ? 'current' : null, when !== null ? `uploaded ${when}` : null].filter(Boolean).join(' · '),
      action: 'Preview',
      source: { kind: 'edition', ed: e },
    });
  }
  for (const d of model.documents?.key_documents ?? []) {
    if (RESUME_KIND.test(d.kind)) continue;
    const rtr = /^rtr\b|right to represent/i.test(d.kind);
    const signedAt = d.signed && d.signed_at !== null ? shortDate(d.signed_at) : null;
    rows.push({
      key: `doc:${d.id}`,
      tone: rtr ? 'rtr' : 'other',
      kind: d.kind,
      reqLabel: d.requisition_label,
      current: false,
      justUploaded: false,
      line2: signedAt !== null ? `Signed ${signedAt}` : (d.meta ?? ''),
      action: d.signed ? 'View' : 'Preview',
      source: { kind: 'doc', d },
    });
  }

  const onUploaded = (edition: TalentResumeEditionView, madeCurrent: boolean, typeLabel: string): void => {
    setJustUploaded((prev) => new Set([...prev, edition.edition_id]));
    setUploadOpen(false);
    void load();
    notify?.(`${typeLabel} uploaded${madeCurrent ? ' · now the current resume' : ''}`);
  };

  const onMakeCurrent = (editionId: string): void => {
    setTalentResumeEditionDefault(talentId, editionId)
      .then((r) => {
        setEditions(r.editions);
        setOpen(null);
        notify?.('Now the current resume');
      })
      .catch((e: unknown) => notify?.(safeErrorMessage(e, 'Could not change the current resume.')));
  };

  return (
    <div className="t360-card t360-card--sect t360-docs" data-testid="t360-docs">
      <div className="t360-card__hd t360-card__hd--docs">
        <span className="t360-sect__title">Documents</span>
        <span className="t360-caption t360-caption--inline">Requisition documents carry their REQ tag.</span>
        {canEdit ? (
          <Button unstyled type="button" className="t360-btn t360-btn--neutral t360-btn--sm t360-docs__upload" onClick={() => setUploadOpen(true)}>
            <Glyph d={ICON.upload} width={2} size={13} />
            Upload
          </Button>
        ) : null}
      </div>
      {editions === null ? <LoadingState label="Loading documents…" /> : null}
      {editions !== null && rows.length === 0 ? <div className="t360-empty">No documents yet.</div> : null}
      {rows.map((r) => (
        <Button
          unstyled
          key={r.key}
          type="button"
          className="t360-drow"
          onClick={() => setOpen(r)}
          aria-label={`${r.action} ${r.kind}${r.reqLabel !== null ? ` · ${r.reqLabel}` : ''}`}
        >
          <span className={`t360-drow__tile t360-drow__tile--${r.tone}`}>
            <Glyph d={ICON.docs} width={1.7} size={14} />
          </span>
          <span className="t360-min0 t360-grow">
            <span className="t360-drow__head">
              <b>{r.kind}</b>
              {r.reqLabel !== null ? <span className="t360-reqtag">{r.reqLabel}</span> : null}
              {r.current ? <span className="t360-pill t360-tone--blue t360-pill--xs">Current</span> : null}
              {r.justUploaded ? <span className="t360-justtag">JUST UPLOADED</span> : null}
            </span>
            <span className="t360-drow__meta">{r.line2}</span>
          </span>
          <span className="t360-drow__act">{r.action}</span>
        </Button>
      ))}
      <div className="t360-docs__foot">
        RTRs and offers are generated by Aramo e-sign and can’t be uploaded or replaced. Work authorization documents are collected at pre-start.
      </div>
      {open !== null ? (
        <DocumentViewer
          row={open}
          talentId={talentId}
          reqs={reqs}
          attachment={open.source.kind === 'edition' && open.source.ed.attachment_id !== null ? (attachments.get(open.source.ed.attachment_id) ?? null) : null}
          names={names}
          canEdit={canEdit}
          onClose={() => setOpen(null)}
          onMakeCurrent={onMakeCurrent}
          onUploadNewer={() => {
            setOpen(null);
            setUploadOpen(true);
          }}
        />
      ) : null}
      {uploadOpen ? (
        <UploadDialog
          talentId={talentId}
          talentName={model.header.display_name}
          opportunities={model.opportunities?.active ?? []}
          onClose={() => setUploadOpen(false)}
          onUploaded={onUploaded}
        />
      ) : null}
    </div>
  );
}

// ── Viewer (§8B.2) ────────────────────────────────────────────────────────────

type PageBody =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'pdf'; url: string }
  | { kind: 'image'; url: string }
  | { kind: 'docx'; html: string }
  | { kind: 'none' };

function DocumentViewer({
  row,
  talentId,
  reqs,
  attachment,
  names,
  canEdit,
  onClose,
  onMakeCurrent,
  onUploadNewer,
}: {
  row: DocRowModel;
  talentId: string;
  reqs: ReadonlyMap<string, ReqInfo>;
  attachment: AttachmentView | null;
  names: Record<string, string>;
  canEdit: boolean;
  onClose: () => void;
  onMakeCurrent: (editionId: string) => void;
  onUploadNewer: () => void;
}): JSX.Element {
  const [body, setBody] = useState<PageBody>({ kind: 'loading' });
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  const [size, setSize] = useState<number | null>(attachment?.size_bytes ?? null);
  const src = row.source;

  useEffect(() => {
    let cancelled = false;
    let blobUrl: string | null = null;
    const render = async (bytes: Uint8Array | null, url: string, name: string, mime: string): Promise<void> => {
      const lower = name.toLowerCase();
      if (mime === 'application/pdf' || lower.endsWith('.pdf')) setBody({ kind: 'pdf', url });
      else if (mime.startsWith('image/') && mime !== 'image/svg+xml') setBody({ kind: 'image', url });
      else if (mime === DOCX_MIME || lower.endsWith('.docx')) {
        const buf = bytes ?? new Uint8Array(await (await fetch(url)).arrayBuffer());
        const mammoth = (await import('mammoth')) as unknown as {
          convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
        };
        const { value } = await mammoth.convertToHtml({ arrayBuffer: buf.buffer as ArrayBuffer });
        if (!cancelled) setBody({ kind: 'docx', html: value });
      } else setBody({ kind: 'none' });
    };
    const run = async (): Promise<void> => {
      if (src.kind === 'edition') {
        const ed = src.ed;
        if (ed.attachment_id === null) {
          setBody({ kind: 'none' });
          return;
        }
        const r = await getAttachmentDownloadUrl(ed.attachment_id);
        if (cancelled) return;
        setDownload({ url: r.presigned_url, name: ed.filename });
        await render(null, r.presigned_url, ed.filename, ed.mime_type);
      } else {
        const doc = await getTalent360DocumentContent(talentId, src.d.id);
        if (cancelled) return;
        const bytes = Uint8Array.from(atob(doc.content_base64), (c) => c.charCodeAt(0));
        const mime = doc.mime_type === '' ? 'application/octet-stream' : doc.mime_type;
        blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setDownload({ url: blobUrl, name: doc.file_name });
        setSize(doc.byte_size);
        await render(bytes, blobUrl, doc.file_name, mime);
      }
    };
    run().catch((e: unknown) => {
      if (!cancelled) setBody({ kind: 'error', message: safeErrorMessage(e, 'This document could not be loaded.') });
    });
    return () => {
      cancelled = true;
      if (blobUrl !== null) URL.revokeObjectURL(blobUrl);
    };
  }, [src, talentId]);

  const ed = src.kind === 'edition' ? src.ed : null;
  const doc = src.kind === 'doc' ? src.d : null;
  const req = ed !== null && ed.requisition_id !== null ? (reqs.get(ed.requisition_id) ?? null) : null;
  const status = doc !== null ? (doc.signed ? 'Signed' : 'Uploaded') : ed?.is_default === true ? 'Current' : 'Uploaded';
  const statusTone = status === 'Signed' ? 't360-tone--green' : status === 'Current' ? 't360-tone--blue' : 't360-tone--grey';
  const fileName = download?.name ?? ed?.filename ?? doc?.meta ?? row.kind;
  const when =
    doc !== null
      ? doc.signed && doc.signed_at !== null
        ? `Signed ${shortDate(doc.signed_at) ?? ''}`
        : null
      : ed !== null
        ? `Uploaded ${shortDate(ed.uploaded_at) ?? ''}`
        : null;
  const uploader = attachment?.uploaded_by_id != null ? (names[attachment.uploaded_by_id] ?? null) : null;

  const details: [string, string][] = [['Type', row.kind]];
  if (ed !== null) {
    details.push(['File', ed.filename]);
    const sz = fileSize(size);
    if (sz !== null) details.push(['Size', sz]);
    details.push(['Uploaded', [shortDate(ed.uploaded_at), uploader].filter(Boolean).join(' · ')]);
    if (req !== null) details.push(['Requisition', req.code]);
    details.push(['Status', ed.is_default ? 'Current resume' : 'Previous version']);
  } else if (doc !== null) {
    if (doc.requisition_label !== null) details.push(['Requisition', doc.requisition_label]);
    details.push(['File', fileName]);
    const sz = fileSize(size);
    if (sz !== null) details.push(['Size', sz]);
  }

  const tailored = ed !== null && isTailored(ed);
  const note =
    ed === null
      ? null
      : tailored
        ? 'Tailored for one requisition. Upload a new tailored resume for later submittals.'
        : ed.is_default
          ? 'Used for new submittals unless a tailored resume is chosen.'
          : 'Not used for new submittals. Make it current to use it again.';

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="xl"
      title={
        <span className="t360-dv__hd">
          <span className={`t360-drow__tile t360-drow__tile--${row.tone} t360-dv__tile`}>
            <Glyph d={ICON.docs} width={1.7} size={15} />
          </span>
          <span className="t360-min0">
            <span className="t360-dv__title">
              {row.kind}
              {row.reqLabel !== null ? <span className="t360-reqtag">{row.reqLabel}</span> : null}
              <span className={`t360-pill t360-pill--xs ${statusTone}`}>{status}</span>
            </span>
            <span className="t360-dv__sub">{[fileName, when, fileSize(size)].filter(Boolean).join(' · ')}</span>
          </span>
        </span>
      }
    >
      <span className="t360-dv__tools">
        {download !== null ? (
          <a className="t360-btn t360-btn--neutral t360-btn--sm" href={download.url} download={download.name}>
            Download
          </a>
        ) : null}
        <DialogClose asChild>
          <Button unstyled type="button" className="t360-email-close t360-dv__close" aria-label="Close document viewer">
            ×
          </Button>
        </DialogClose>
      </span>
      <div className="t360-dv__body">
        <div className="t360-dv__page">
          {tailored && req !== null ? (
            <div className="t360-dv__banner">
              Tailored for {[req.client, req.role].filter(Boolean).join(' · ')} ({req.code})
            </div>
          ) : null}
          {body.kind === 'loading' ? <LoadingState label="Loading document…" /> : null}
          {body.kind === 'error' ? <InlineAlert variant="error">{body.message}</InlineAlert> : null}
          {body.kind === 'pdf' ? <iframe className="t360-dv__frame" title={`Preview of ${fileName}`} src={body.url} /> : null}
          {body.kind === 'image' ? <img className="t360-dv__img" src={body.url} alt={fileName} /> : null}
          {body.kind === 'docx' ? (
            <div className="t360-dv__sheet rc-rpreview__docx" dangerouslySetInnerHTML={{ __html: body.html }} />
          ) : null}
          {body.kind === 'none' ? <div className="t360-empty">Preview not available for this file type · Download to open it.</div> : null}
        </div>
        <aside className="t360-dv__side">
          <div className="t360-dv__lbl">DETAILS</div>
          <dl className="t360-dv__dl">
            {details.map(([k, v]) => (
              <div key={k} className="t360-dv__row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {doc !== null && doc.signed ? (
            <div className="t360-dv__esign">
              <b>Signed in Aramo e-sign</b>
              {doc.signed_at !== null ? (
                <div className="t360-dv__row">
                  <dt>Completed</dt>
                  <dd>{shortDate(doc.signed_at)}</dd>
                </div>
              ) : null}
            </div>
          ) : null}
          {doc !== null && doc.signed ? (
            <p className="t360-dv__note">Signed documents are read-only. They can’t be replaced or deleted; a new RTR is sent from the requisition.</p>
          ) : null}
          {ed !== null && canEdit && !tailored ? (
            ed.is_default ? (
              <Button unstyled type="button" className="t360-btn t360-btn--neutral t360-dv__wide" onClick={onUploadNewer}>
                Upload a newer version
              </Button>
            ) : (
              <Button unstyled type="button" className="t360-btn t360-btn--neutral t360-dv__wide" onClick={() => onMakeCurrent(ed.edition_id)}>
                Make current resume
              </Button>
            )
          ) : null}
          {note !== null ? <p className="t360-dv__note">{note}</p> : null}
        </aside>
      </div>
    </Dialog>
  );
}

// ── Upload (§8B.3) ────────────────────────────────────────────────────────────

// Only the resume chain exists today: other document types have no upload
// endpoint (and a non-resume object would be swept by the orphan lifecycle).
const UPLOAD_TYPES = [
  { key: 'resume', label: 'Resume' },
  { key: 'tailored', label: 'Resume · tailored' },
] as const;
type UploadType = (typeof UPLOAD_TYPES)[number]['key'];

// The storage PUT, with real progress (XMLHttpRequest exposes upload progress;
// fetch does not). Same contract as putResumeToStorage.
function putWithProgress(url: string, file: File, contentType: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}

function UploadDialog({
  talentId,
  talentName,
  opportunities,
  onClose,
  onUploaded,
}: {
  talentId: string;
  talentName: string;
  opportunities: readonly { requisition_id: string; requisition_code: string; client_name: string | null }[];
  onClose: () => void;
  onUploaded: (edition: TalentResumeEditionView, madeCurrent: boolean, typeLabel: string) => void;
}): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [type, setType] = useState<UploadType>('resume');
  const [reqId, setReqId] = useState('');
  const [makeCurrent, setMakeCurrent] = useState(true);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const choose = (f: File | undefined): void => {
    if (f === undefined) return;
    const lower = f.name.toLowerCase();
    if (!['.pdf', '.doc', '.docx'].some((x) => lower.endsWith(x))) {
      setFile(null);
      setFileError('That file type isn’t supported for a resume. Use PDF or Word.');
      return;
    }
    if (f.size > MAX_BYTES) {
      setFile(null);
      setFileError('That file is larger than 10 MB.');
      return;
    }
    setFileError(null);
    setFile(f);
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>): void => {
    e.preventDefault();
    setDrag(false);
    choose(e.dataTransfer.files[0]);
  };

  const needsReq = type === 'tailored';
  const ready = file !== null && (!needsReq || reqId !== '') && !busy;
  const typeLabel = UPLOAD_TYPES.find((t) => t.key === type)?.label ?? 'Resume';

  const submit = (): void => {
    if (file === null || !ready) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    const contentType = file.type === '' ? 'application/octet-stream' : file.type;
    const current = type === 'resume' && makeCurrent;
    requestResumeUploadUrl({ filename: file.name, content_type: contentType })
      .then((presign) =>
        putWithProgress(presign.presigned_url, file, contentType, setProgress).then(() =>
          createAttachment({
            owner_type: 'talent',
            owner_id: talentId,
            file_name: file.name,
            mime: contentType,
            size_bytes: file.size,
            storage_key: presign.storage_key,
            is_resume: true,
          }),
        ),
      )
      .then((att) =>
        createTalentResumeEdition(talentId, {
          attachment_id: att.id,
          ...(needsReq ? { purpose: 'REQUISITION', requisition_id: reqId } : {}),
        }),
      )
      .then(async (edition) => {
        if (current) await setTalentResumeEditionDefault(talentId, edition.edition_id);
        onUploaded(edition, current, typeLabel);
      })
      .catch((e: unknown) => {
        setBusy(false);
        setError(safeErrorMessage(e, 'The upload didn’t complete. Try again.'));
      });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      size="md"
      title={
        <span className="t360-dv__hd">
          <span className="t360-drow__tile t360-drow__tile--resume t360-dv__tile">
            <Glyph d={ICON.upload} width={2} size={15} />
          </span>
          <span>
            <span className="t360-dv__title">Upload document</span>
            <span className="t360-dv__sub">{talentName} · saved to this talent’s documents</span>
          </span>
        </span>
      }
      footer={
        <span className="t360-up__foot">
          <Button unstyled type="button" className="t360-btn t360-btn--neutral" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button unstyled type="button" className="t360-btn t360-btn--primary t360-up__go" disabled={!ready} onClick={submit}>
            {busy ? 'Uploading…' : 'Upload'}
          </Button>
        </span>
      }
    >
      <div className="t360-up">
        <label
          className={`t360-up__drop${drag ? ' t360-up__drop--over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          {/* eslint-disable-next-line no-restricted-syntax -- G1/A3 escape hatch: native file picker — distinct native behavior, no fe-foundation primitive */}
          <input ref={inputRef} type="file" accept={ACCEPT} hidden disabled={busy} onChange={(e) => choose(e.target.files?.[0])} />
          {file === null ? (
            <>
              <Glyph d={ICON.upload} width={2} size={22} />
              <span className="t360-up__drop-t">
                Drag a file here or <span className="t360-ink-brand">choose a file</span>
              </span>
              <span className="t360-up__drop-s">PDF or Word · up to 10 MB</span>
            </>
          ) : (
            <>
              <span className="t360-up__file">{file.name}</span>
              <span className="t360-up__drop-s">{fileSize(file.size)} · click to choose a different file</span>
            </>
          )}
        </label>
        {fileError !== null ? <div className="t360-up__err">{fileError}</div> : null}
        <div className="t360-up__cols">
          <label className="t360-up__field">
            <span>
              Document type <span className="t360-req">*</span>
            </span>
            <Select unstyled className="t360-ctl" aria-label="Document type" value={type} disabled={busy} onChange={(e) => setType(e.target.value as UploadType)}>
              {UPLOAD_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="t360-up__field">
            <span>
              Requisition {needsReq ? <span className="t360-req">*</span> : <span className="t360-up__opt">· optional</span>}
            </span>
            <Select
              unstyled
              className={`t360-ctl${needsReq && reqId === '' ? ' t360-ctl--err' : ''}`}
              aria-label="Requisition"
              value={reqId}
              disabled={busy}
              onChange={(e) => setReqId(e.target.value)}
            >
              <option value="">None</option>
              {opportunities.map((o) => (
                <option key={o.requisition_id} value={o.requisition_id}>
                  {[o.requisition_code, o.client_name].filter(Boolean).join(' · ')}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {type === 'resume' ? (
          <label className="t360-up__check">
            {/* eslint-disable-next-line no-restricted-syntax -- G1/A3 escape hatch: native checkbox — no fe-foundation primitive */}
            <input type="checkbox" checked={makeCurrent} disabled={busy} onChange={(e) => setMakeCurrent(e.target.checked)} />
            <span>
              Make this the current resume
              <small>The previous resume stays in Documents. Submittals already sent keep the resume they used.</small>
            </span>
          </label>
        ) : null}
        <div className="t360-up__info">
          RTRs and offers are created and signed in Aramo e-sign, so they aren’t uploaded here. Work authorization documents are collected at pre-start.
        </div>
        {busy ? (
          <div className="t360-up__bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      </div>
    </Dialog>
  );
}
