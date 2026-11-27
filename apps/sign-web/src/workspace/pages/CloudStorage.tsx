import { ApiError, Dialog } from '@aramo/fe-foundation';
import { CLOUD_EXPORT_FOLDER, CLOUD_PROVIDER_LABELS, CLOUD_STORAGE_COPY, cloudConnectResultOf, cloudProvidersOf, type CloudProviderId } from '@aramo/sign-client';
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { errorMessage, type UploadedDocument } from '../api';
import { cloudApi, navigateTo, type CloudApi, type CloudItem, type CloudProviderRow } from '../cloud-storage-api';
import { Bare, Btn, ErrorBox, Icon, LinkBtn, Loading, TextIn, fmtBytes, fmtDate } from '../ui';
import { useWorkspace } from '../workspace';

// SIGN-FREE-PARITY-1 S6 (FP-R7) — cloud storage on the web: Settings → Connected storage,
// "From cloud storage" in the envelope wizard, and "Save to …" on a completed envelope. Every
// button shows only while the sender context lists a provider (`cloud_storage`, server-decided;
// empty while dark). Connecting is a full-page trip: this page → the provider's sign-in →
// sign-service → back here with ?cloud_storage=connected|cancelled|failed.

/** The connect result in this page's address, shown once and then removed from the address. */
function useConnectResult(): { status: 'connected' | 'cancelled' | 'failed'; provider: CloudProviderId | null } | null {
  const location = useLocation();
  const navigate = useNavigate();
  const [result] = useState(() => cloudConnectResultOf(location.search));
  useEffect(() => {
    if (result === null) return;
    const p = new URLSearchParams(location.search);
    p.delete('cloud_storage');
    p.delete('provider');
    const rest = p.toString();
    navigate(`${location.pathname}${rest ? `?${rest}` : ''}`, { replace: true });
    // Once, on arrival.
  }, []);
  return result;
}

function connectNotice(r: ReturnType<typeof useConnectResult>): { ok: boolean; text: string } | null {
  if (r === null) return null;
  if (r.status === 'connected' && r.provider !== null) return { ok: true, text: CLOUD_STORAGE_COPY.connected(r.provider) };
  if (r.status === 'cancelled') return { ok: false, text: CLOUD_STORAGE_COPY.cancelled };
  return { ok: false, text: CLOUD_STORAGE_COPY.failed };
}

async function startConnect(api: CloudApi, provider: CloudProviderId, returnPath: string, go: (url: string) => void): Promise<void> {
  const { authorize_url } = await api.connect(provider, returnPath);
  go(authorize_url);
}

// ── Settings → Connected storage ─────────────────────────────────────────────

export function CloudStorageSection({ api = cloudApi, go = navigateTo }: { api?: CloudApi; go?: (url: string) => void } = {}) {
  const { pathname } = useLocation();
  const result = useConnectResult();
  const [rows, setRows] = useState<CloudProviderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<CloudProviderId | null>(null);
  const notice = connectNotice(result);

  const load = useCallback(() => {
    api.list().then(setRows, (e: unknown) => setError(errorMessage(e, 'Connected storage couldn’t be loaded. Try again.')));
  }, [api]);
  useEffect(load, [load]);

  const connect = async (p: CloudProviderId) => {
    setBusy(true);
    setError(null);
    try {
      await startConnect(api, p, pathname, go);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const disconnect = async (p: CloudProviderId) => {
    setBusy(true);
    setError(null);
    try {
      await api.disconnect(p);
      setConfirming(null);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sg-card" data-testid="settings-cloud-storage">
      <div className="sg-card__head">{CLOUD_STORAGE_COPY.settings_title}</div>
      <div className="sg-card__body">
        <p className="sg-muted" style={{ marginTop: 0 }}>
          {CLOUD_STORAGE_COPY.settings_intro}
        </p>
        {notice !== null ? (
          <p role="status" className={notice.ok ? 'sg-help' : 'sg-help sg-bad'} data-testid="cloud-connect-notice">
            {notice.text}
          </p>
        ) : null}
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        {rows === null && error === null ? <Loading /> : null}
        {rows !== null ? (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {rows.map((r) => (
              <li key={r.provider} data-testid={`cloud-row-${r.provider}`} style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <strong>{r.label}</strong>
                    <div className="sg-muted">
                      {r.connected ? `${r.account_label ?? 'Connected'}${r.connected_at ? ` · since ${fmtDate(r.connected_at)}` : ''}` : CLOUD_STORAGE_COPY.not_connected}
                    </div>
                  </div>
                  {r.connected ? (
                    confirming === r.provider ? null : (
                      <Btn size="sm" disabled={busy} onClick={() => setConfirming(r.provider)} aria-label={`Disconnect ${r.label}`}>
                        {CLOUD_STORAGE_COPY.disconnect}
                      </Btn>
                    )
                  ) : (
                    <Btn size="sm" variant="primary" disabled={busy} onClick={() => void connect(r.provider)} aria-label={`Connect ${r.label}`} data-testid={`cloud-connect-${r.provider}`}>
                      {CLOUD_STORAGE_COPY.connect}
                    </Btn>
                  )}
                </div>
                {confirming === r.provider ? (
                  <div role="alertdialog" aria-label={`Disconnect ${r.label}`} style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span>{CLOUD_STORAGE_COPY.disconnect_confirm}</span>
                    <Btn size="sm" variant="danger" disabled={busy} onClick={() => void disconnect(r.provider)} data-testid="cloud-disconnect-confirm">
                      {CLOUD_STORAGE_COPY.disconnect}
                    </Btn>
                    <Btn size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                      Cancel
                    </Btn>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

// ── the file browser (import) and the folder chooser (export) ─────────────────

function Browser({
  api,
  provider,
  mode,
  onPickFile,
  onPickFolder,
  busy,
}: {
  api: CloudApi;
  provider: CloudProviderId;
  mode: 'file' | 'folder';
  onPickFile?: (f: CloudItem) => void;
  onPickFolder?: (folder: { id: string; name: string }) => void;
  busy: boolean;
}) {
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [items, setItems] = useState<CloudItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const folder = path[path.length - 1] ?? null;

  const fetchPage = useCallback(
    (more: string | null) => {
      setError(null);
      if (more === null) setItems(null);
      api.items(provider, { folder_id: search === null ? (folder?.id ?? null) : null, q: search, cursor: more, folders: mode === 'folder' }).then(
        (page) => {
          setItems((prev) => (more === null ? page.items : [...(prev ?? []), ...page.items]));
          setCursor(page.next_cursor);
        },
        (e: unknown) => setError(errorMessage(e)),
      );
    },
    [api, provider, folder, search, mode],
  );
  useEffect(() => fetchPage(null), [fetchPage]);

  return (
    <div data-testid="cloud-browser">
      {mode === 'file' ? (
        <form
          style={{ display: 'flex', gap: 8, marginBottom: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim() === '' ? null : query.trim());
          }}
        >
          <TextIn aria-label={CLOUD_STORAGE_COPY.search_placeholder} placeholder={CLOUD_STORAGE_COPY.search_placeholder} value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1 }} />
          <Btn type="submit" size="sm">
            <Icon name="search" size={14} />
          </Btn>
        </form>
      ) : null}
      {search === null && path.length > 0 ? (
        <LinkBtn onClick={() => setPath((p) => p.slice(0, -1))} data-testid="cloud-up">
          <Icon name="back" size={12} /> {CLOUD_STORAGE_COPY.back_to_folder}
        </LinkBtn>
      ) : null}
      {search !== null ? (
        <LinkBtn
          onClick={() => {
            setSearch(null);
            setQuery('');
          }}
        >
          <Icon name="back" size={12} /> {CLOUD_STORAGE_COPY.back_to_folder}
        </LinkBtn>
      ) : null}
      <div className="sg-muted" style={{ margin: '6px 0' }}>
        {search !== null ? `“${search}”` : [CLOUD_PROVIDER_LABELS[provider], ...path.map((p) => p.name)].join(' › ')}
      </div>
      {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
      {items === null && error === null ? <Loading /> : null}
      {items !== null && items.length === 0 ? <p className="sg-muted">{search !== null ? CLOUD_STORAGE_COPY.no_results : CLOUD_STORAGE_COPY.empty_folder}</p> : null}
      {items !== null && items.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 320, overflowY: 'auto' }}>
          {items.map((i) => (
            <li key={i.id} style={{ borderTop: '1px solid var(--line)' }}>
              <Bare
                type="button"
                className="sg-bare"
                disabled={busy}
                data-testid={`cloud-item-${i.id}`}
                style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', padding: '8px 4px', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }}
                onClick={() => (i.kind === 'folder' ? setPath((p) => [...p, { id: i.id, name: i.name }]) : onPickFile?.(i))}
              >
                <Icon name={i.kind === 'folder' ? 'grid' : 'doc'} size={14} />
                <span style={{ flex: 1 }}>{i.name}</span>
                {i.kind === 'file' ? <span className="sg-muted">{fmtBytes(i.size)}</span> : null}
              </Bare>
            </li>
          ))}
        </ul>
      ) : null}
      {cursor !== null ? (
        <LinkBtn onClick={() => fetchPage(cursor)} disabled={busy}>
          Show more
        </LinkBtn>
      ) : null}
      {mode === 'folder' && folder !== null ? (
        <div style={{ marginTop: 10 }}>
          <Btn variant="primary" disabled={busy} onClick={() => onPickFolder?.(folder)} data-testid="cloud-save-here">
            Save in “{folder.name}”
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

/** The provider list of the dialogs: connected ones open, the others offer Connect. */
function ProviderChooser({ rows, onOpen, onConnect, busy }: { rows: CloudProviderRow[]; onOpen: (p: CloudProviderId) => void; onConnect: (p: CloudProviderId) => void; busy: boolean }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {rows.map((r) => (
        <li key={r.provider} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--line)' }}>
          <span style={{ flex: 1 }}>
            <strong>{r.label}</strong>
            {r.connected && r.account_label !== null ? <span className="sg-muted"> · {r.account_label}</span> : null}
          </span>
          {r.connected ? (
            <Btn size="sm" variant="primary" disabled={busy} onClick={() => onOpen(r.provider)} data-testid={`cloud-open-${r.provider}`}>
              Open
            </Btn>
          ) : (
            <Btn size="sm" disabled={busy} onClick={() => onConnect(r.provider)} data-testid={`cloud-connect-${r.provider}`}>
              {CLOUD_STORAGE_COPY.connect}
            </Btn>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Envelope wizard: "From cloud storage" ────────────────────────────────────

export function CloudImportButton({
  envelopeId,
  onImported,
  api = cloudApi,
  go = navigateTo,
}: {
  envelopeId: string;
  /** The imported document (its attached-files count included, PDF-ATTACH-1) and the cloud file name. */
  onImported: (uploaded: UploadedDocument, name: string) => void | Promise<void>;
  api?: CloudApi;
  go?: (url: string) => void;
}) {
  const { ctx } = useWorkspace();
  const { pathname } = useLocation();
  const offered = cloudProvidersOf(ctx);
  const result = useConnectResult();
  const [open, setOpen] = useState(result?.status === 'connected' && result.provider !== null);
  const [rows, setRows] = useState<CloudProviderRow[] | null>(null);
  const [provider, setProvider] = useState<CloudProviderId | null>(result?.status === 'connected' ? result.provider : null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(result !== null && result.status !== 'connected' ? connectNotice(result)?.text ?? null : null);

  useEffect(() => {
    if (!open) return;
    api.list().then(setRows, (e: unknown) => setError(errorMessage(e)));
  }, [open, api]);

  if (offered.length === 0) return null;

  const pick = async (f: CloudItem) => {
    if (provider === null) return;
    setBusy(`Adding ${f.name}…`);
    setError(null);
    try {
      const uploaded = await api.importFile(envelopeId, provider, f.id);
      setOpen(false);
      setProvider(null);
      await onImported(uploaded, f.name);
    } catch (e) {
      // The grant was revoked or expired: back to the provider list to connect again.
      if (e instanceof ApiError && e.status === 409) setProvider(null);
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  };
  const connect = async (p: CloudProviderId) => {
    setBusy('…');
    try {
      await startConnect(api, p, pathname, go);
    } catch (e) {
      setError(errorMessage(e));
      setBusy('');
    }
  };

  return (
    <>
      <Btn onClick={() => setOpen(true)} data-testid="from-cloud-storage">
        {CLOUD_STORAGE_COPY.from_cloud}
      </Btn>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setProvider(null);
            setError(null);
          }
        }}
        title={provider === null ? CLOUD_STORAGE_COPY.choose_provider : CLOUD_STORAGE_COPY.choose_file}
        size="md"
        footer={
          <>
            {provider !== null ? <Btn onClick={() => setProvider(null)}>Back</Btn> : null}
            <Btn onClick={() => setOpen(false)}>Cancel</Btn>
          </>
        }
      >
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        {busy !== '' && busy !== '…' ? (
          <p role="status" className="sg-muted">
            {busy}
          </p>
        ) : null}
        {provider === null ? (
          rows === null ? (
            <Loading />
          ) : (
            <ProviderChooser rows={rows} busy={busy !== ''} onOpen={setProvider} onConnect={(p) => void connect(p)} />
          )
        ) : (
          <Browser api={api} provider={provider} mode="file" busy={busy !== ''} onPickFile={(f) => void pick(f)} />
        )}
      </Dialog>
    </>
  );
}

// ── Envelope detail: "Save to …" ─────────────────────────────────────────────

export function CloudExportButton({ envelopeId, api = cloudApi, go = navigateTo }: { envelopeId: string; api?: CloudApi; go?: (url: string) => void }) {
  const { ctx, toast } = useWorkspace();
  const { pathname } = useLocation();
  const offered = cloudProvidersOf(ctx);
  const result = useConnectResult();
  const [open, setOpen] = useState(result !== null);
  const [rows, setRows] = useState<CloudProviderRow[] | null>(null);
  const [provider, setProvider] = useState<CloudProviderRow | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(result !== null && result.status !== 'connected' ? connectNotice(result)?.text ?? null : null);

  useEffect(() => {
    if (!open) return;
    api.list().then(
      (list) => {
        setRows(list);
        if (result?.status === 'connected') setProvider(list.find((r) => r.provider === result.provider && r.connected) ?? null);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  }, [open, api]);

  if (offered.length === 0) return null;

  const close = () => {
    setOpen(false);
    setProvider(null);
    setChoosing(false);
    setError(null);
  };
  const save = async (p: CloudProviderId, folder_id?: string) => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.exportExecuted(envelopeId, p, folder_id);
      close();
      toast(CLOUD_STORAGE_COPY.saved(p, out.folder.name));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setProvider(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = async (p: CloudProviderId) => {
    setBusy(true);
    try {
      await startConnect(api, p, pathname, go);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <Btn onClick={() => setOpen(true)} disabled={busy} data-testid="save-to-cloud">
        Save to…
      </Btn>
      <Dialog
        open={open}
        onOpenChange={(o) => (o ? setOpen(true) : close())}
        title={provider === null ? 'Save the signed copy' : CLOUD_STORAGE_COPY.save_to(provider.provider)}
        size="md"
        footer={
          <>
            {provider !== null ? (
              <Btn
                onClick={() => {
                  setProvider(null);
                  setChoosing(false);
                }}
              >
                Back
              </Btn>
            ) : null}
            <Btn onClick={close}>Cancel</Btn>
          </>
        }
      >
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        {provider === null ? (
          rows === null ? (
            <Loading />
          ) : (
            <ProviderChooser
              rows={rows}
              busy={busy}
              onOpen={(p) => setProvider(rows.find((r) => r.provider === p) ?? null)}
              onConnect={(p) => void connect(p)}
            />
          )
        ) : choosing ? (
          <Browser api={api} provider={provider.provider} mode="folder" busy={busy} onPickFolder={(f) => void save(provider.provider, f.id)} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
            <p className="sg-muted" style={{ margin: 0 }}>
              {CLOUD_STORAGE_COPY.save_folder_default}
            </p>
            <Btn variant="primary" disabled={busy} onClick={() => void save(provider.provider)} data-testid="cloud-save-default">
              Save to “{CLOUD_EXPORT_FOLDER}”
            </Btn>
            {provider.folder_choice ? (
              <LinkBtn disabled={busy} onClick={() => setChoosing(true)} data-testid="cloud-choose-folder">
                Choose another folder
              </LinkBtn>
            ) : null}
          </div>
        )}
      </Dialog>
    </>
  );
}
