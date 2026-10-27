// Runs an Agreements row action (M-A4 §3.5–§3.7) the way the detail screens do:
//   Sign   -> the existing inbox signing route
//   Remind -> one reminder intent after reading the detail (listActions.remindFromList)
//   Void   -> the reason sheet, then void with the detail's ETag (412 = refresh, never resubmit)
//   Edit   -> Send flow with the envelope (after the server says it is `editable`), or
//             the on-device draft
//   Delete -> confirm, then delete with the current ETag (or forget an on-device draft)
//   Share  -> the completed PDF through the OS share sheet (features/share)
// Usable by any list that renders AgreementRowItem inside SwipeActions.
import { useNavigation } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import { refusalMessage } from '../../api/refusalMessages';
import { useServices } from '../../app/ServicesContext';
import { useToast } from '../../components/Toast';
import { shareTargetFor } from '../share/shareCompleted';
import { useShare } from '../share/useShare';
import { createDocumentBytesStore } from '../send/documentBytes';
import { forgetLocalDrafts } from '../send/localDrafts';
import type { AgreementRow } from './agreementsModel';
import { deleteDraftById, VOID_REASON_MIN } from './envelopeActions';
import { checkEditable, remindFromList, voidFromList } from './listActions';
import { OFFLINE_ACTION_REASON, putDetail, signKeys, useOnline, useSenderContext } from './queries';
import { confirmDeleteDraft, type SwipeHandle } from './SwipeActions';
import { swipeActionsFor, type SwipeAction, type SwipeActionKind } from './rowActionRules';
import { ReasonSheet } from './ui';

const STALE = refusalMessage({ reason: 'revision_mismatch', code: 'revision_mismatch' });

export function useRowActions(): {
  readonly actionsFor: (row: AgreementRow) => SwipeAction[];
  readonly run: (row: AgreementRow, kind: SwipeActionKind) => void;
  /** Keeps one swiped row open at a time. */
  readonly onRowOpen: (handle: SwipeHandle) => void;
  readonly sheets: ReactNode;
} {
  const navigation = useNavigation();
  const services = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const ctx = useSenderContext();
  const [voidRow, setVoidRow] = useState<Extract<AgreementRow, { kind: 'sent' }> | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const openRow = useRef<SwipeHandle | null>(null);
  const busy = useRef(false);
  const sharer = useShare();

  const actionsFor = useCallback(
    (row: AgreementRow) => swipeActionsFor(row, { sender: ctx.data, online }),
    [ctx.data, online],
  );

  const onRowOpen = useCallback((handle: SwipeHandle) => {
    if (openRow.current && openRow.current !== handle) openRow.current.close();
    openRow.current = handle;
  }, []);

  const refreshLists = () => {
    void qc.invalidateQueries({ queryKey: signKeys.senderList });
    void qc.invalidateQueries({ queryKey: signKeys.localDrafts });
  };

  async function once(work: () => Promise<void>): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    try {
      await work();
    } finally {
      busy.current = false;
    }
  }

  async function remove(row: AgreementRow): Promise<void> {
    const bytes = createDocumentBytesStore(services.store);
    if (row.kind === 'local-draft') {
      await forgetLocalDrafts(services.drafts, bytes, { localDraftId: row.localDraftId });
    } else if (row.kind === 'sent') {
      const r = await deleteDraftById(services.workspace, row.envelopeId);
      if (r.kind !== 'deleted') {
        toast.show(r.kind === 'stale' ? STALE : r.message);
        return;
      }
      await forgetLocalDrafts(services.drafts, bytes, { envelopeId: row.envelopeId }).catch(
        () => 0,
      );
    } else return;
    toast.show('Draft deleted');
    refreshLists();
  }

  async function remind(row: Extract<AgreementRow, { kind: 'sent' }>): Promise<void> {
    const r = await remindFromList(services.workspace, row.envelopeId, ctx.data);
    if (r.kind === 'sent') {
      putDetail(qc, r.value);
      toast.show('Reminder sent');
      void qc.invalidateQueries({ queryKey: signKeys.events(row.envelopeId) });
    } else toast.show(r.message);
  }

  async function edit(row: Extract<AgreementRow, { kind: 'sent' }>): Promise<void> {
    const r = await checkEditable(services.workspace, row.envelopeId, ctx.data);
    if (r.kind === 'editable') navigation.navigate('SendFlow', { envelopeId: row.envelopeId });
    else toast.show(r.message);
  }

  async function doVoid(reason: string): Promise<void> {
    const row = voidRow;
    if (!row) return;
    setVoidBusy(true);
    setVoidError(null);
    const r = await voidFromList(services.workspace, row.envelopeId, ctx.data, reason);
    setVoidBusy(false);
    if (r.kind === 'voided') {
      putDetail(qc, r.value);
      setVoidRow(null);
      toast.show('Envelope voided');
      void qc.invalidateQueries({ queryKey: signKeys.senderList });
      void qc.invalidateQueries({ queryKey: signKeys.events(row.envelopeId) });
    } else if (r.kind === 'stale') {
      setVoidRow(null);
      toast.show(STALE);
      void qc.invalidateQueries({ queryKey: signKeys.senderList });
    } else setVoidError(r.message);
  }

  function run(row: AgreementRow, kind: SwipeActionKind): void {
    // Only an action the row offers right now runs (the same rule as the swipe).
    if (!actionsFor(row).some((a) => a.kind === kind)) return;
    switch (kind) {
      case 'sign':
        if (row.kind === 'received')
          navigation.navigate('Signing', { envelopeId: row.inboxItemId });
        return;
      case 'edit':
        if (row.kind === 'local-draft')
          navigation.navigate('SendFlow', { localDraftId: row.localDraftId });
        else if (row.kind === 'sent') void once(() => edit(row));
        return;
      case 'delete':
        confirmDeleteDraft(() => void once(() => remove(row)));
        return;
      case 'remind':
        if (row.kind === 'sent') void once(() => remind(row));
        return;
      case 'void':
        if (row.kind === 'sent') {
          setVoidError(null);
          setVoidRow(row);
        }
        return;
      case 'share':
        sharer.share(shareTargetFor(row));
        return;
    }
  }

  const sheets = (
    <ReasonSheet
      visible={voidRow !== null}
      title="Void this envelope?"
      body="Recipients can no longer open or sign it. They’re told it was voided. This can’t be undone."
      confirmLabel="Void envelope"
      placeholder="Reason (required)"
      minLength={VOID_REASON_MIN}
      busy={voidBusy}
      error={voidError}
      disabledReason={online ? null : OFFLINE_ACTION_REASON}
      onConfirm={(r) => void doVoid(r)}
      onClose={() => setVoidRow(null)}
    />
  );

  return { actionsFor, run, onRowOpen, sheets };
}
