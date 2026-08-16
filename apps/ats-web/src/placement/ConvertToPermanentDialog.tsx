import { Button, Dialog, InlineAlert, useToast } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';

import {
  getEffectiveGuaranteeTerms,
} from '../requisitions/guarantee-terms-api';
import {
  TERMS_REMEDY_POLICY_LABELS,
  type GuaranteeTermVersionView,
  type TermsRemedyPolicy,
} from '../requisitions/guarantee-terms-types';

import { formatMoney } from './commercial-format';
import { convertAssignmentToPermanent } from './placement-api';
import type { ConvertToPermanentResponse } from './types';

// Track 7 / T7-PX §14 — the Contract-to-Permanent conversion confirmation. Ending the
// contract and materialising the permanent placement is ONE governed command with lasting
// effect, so it follows the house destructive-confirm convention (Dialog size="sm", explicit
// Cancel + a data-testid confirm, busy label, inline error). It explains that the contract
// assignment ends, that future contract commercial revisions stop, PREVIEWS the effective
// permanent guarantee terms (read-only, from the governed stored version for the requisition),
// that the guarantee starts from the conversion date, and that the action is not reversible
// through this command. It performs exactly ONE POST (no client-side end-then-create) and, on
// success, hands the parent the result so it can navigate to the NEW permanent placement.
// The parent only mounts this when the assignment is ACTIVE and the actor holds BOTH
// assignment:end and placement:permanent:transition.
interface Props {
  readonly open: boolean;
  readonly placementId: string;
  readonly requisitionId: string;
  readonly onClose: () => void;
  /** Hand the parent the conversion result so it can navigate to the new permanent placement. */
  readonly onConverted: (result: ConvertToPermanentResponse) => void;
  readonly convertFn?: (id: string) => Promise<ConvertToPermanentResponse>;
  readonly effectiveTermsFn?: (requisitionId: string) => Promise<GuaranteeTermVersionView>;
}

type TermsState =
  | { status: 'loading' }
  | { status: 'ready'; terms: GuaranteeTermVersionView }
  | { status: 'absent' };

export function ConvertToPermanentDialog({
  open,
  placementId,
  requisitionId,
  onClose,
  onConverted,
  convertFn,
  effectiveTermsFn,
}: Props) {
  const convertFun = convertFn ?? convertAssignmentToPermanent;
  const effectiveFun = effectiveTermsFn ?? getEffectiveGuaranteeTerms;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [termsState, setTermsState] = useState<TermsState>({ status: 'loading' });
  const toast = useToast();

  // Preview the governed guarantee terms effective for the requisition (§14). A 404 = no
  // effective version → the conversion would fail closed; we surface that up-front.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setTermsState({ status: 'loading' });
    effectiveFun(requisitionId)
      .then((terms) => {
        if (!cancelled) setTermsState({ status: 'ready', terms });
      })
      .catch(() => {
        if (!cancelled) setTermsState({ status: 'absent' });
      });
    return () => {
      cancelled = true;
    };
  }, [open, effectiveFun, requisitionId]);

  const reset = () => {
    setBusy(false);
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await convertFun(placementId);
      toast.show('Converted to a permanent placement.');
      reset();
      // Do NOT flip state locally — hand the parent the server truth to navigate to.
      onConverted(result);
      onClose();
    } catch {
      setError('Could not convert this placement. Ensure governed guarantee terms are in effect and try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
      title="Convert to a permanent placement?"
      description="This ends the contract assignment and creates a permanent placement in one step. It cannot be reversed through this action."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="convert-to-permanent-confirm">
            {busy ? 'Converting…' : 'Convert to permanent'}
          </Button>
        </>
      }
    >
      <ul className="rc-muted-line" data-testid="convert-explainer">
        <li>The contract assignment ends (recorded as converted to permanent — not attrition).</li>
        <li>Future contract commercial revisions stop; the commercial history is preserved.</li>
        <li>The permanent guarantee starts from the conversion date (today).</li>
      </ul>

      {termsState.status === 'loading' && (
        <p className="rc-muted-line" data-testid="convert-terms-loading">
          Loading the effective guarantee terms…
        </p>
      )}
      {termsState.status === 'absent' && (
        <InlineAlert variant="error">
          No governed guarantee terms are in effect for this requisition. Add guarantee terms before converting.
        </InlineAlert>
      )}
      {termsState.status === 'ready' && (
        <dl className="rc-deflist" data-testid="convert-terms-preview">
          <div className="rc-defrow">
            <dt>Guarantee duration</dt>
            <dd data-testid="convert-terms-duration">{termsState.terms.guarantee_duration_days} days</dd>
          </div>
          <div className="rc-defrow">
            <dt>Guarantee exposure</dt>
            <dd className="num" data-testid="convert-terms-exposure">
              {formatMoney(termsState.terms.guarantee_exposure_amount, termsState.terms.currency, '')}
            </dd>
          </div>
          <div className="rc-defrow">
            <dt>Remedy policy</dt>
            <dd data-testid="convert-terms-remedy">{TERMS_REMEDY_POLICY_LABELS[termsState.terms.remedy_policy as TermsRemedyPolicy]}</dd>
          </div>
        </dl>
      )}

      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
    </Dialog>
  );
}
