import { useState } from 'react';
import { Dialog } from '@aramo/fe-foundation';

import { errorMessage, smsCertificationApi, type SmsCertificationStatus } from '../api';
import { SMS_CERTIFICATION_WORDING, SMS_CERTIFICATION_WORDING_VERSION } from '../sms-consent-copy';
import { Btn, ErrorBox, fmtDate } from '../ui';
import { useWorkspace } from '../workspace';

// SMS-CONSENT-1 §2 (R-2) — Settings → Text messages (SMS), for a Business organization's
// owner or admin. They certify once, for the organization, that recipients agree to texts;
// until then the send flow offers no text options. Withdraw turns them off again. The
// settings page shows this section only while the server says texts are available; the
// server checks the role on every write.

export function SmsCertificationSection({
  status,
  onChange,
}: {
  status: SmsCertificationStatus;
  onChange: (s: SmsCertificationStatus) => void;
}) {
  const { toast } = useWorkspace();
  const [confirm, setConfirm] = useState<'certify' | 'withdraw' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const wording =
    status.wording !== null && status.wording.trim() !== ''
      ? status.wording
      : SMS_CERTIFICATION_WORDING;
  const version = status.wording_version ?? SMS_CERTIFICATION_WORDING_VERSION;

  const act = async (kind: 'certify' | 'withdraw') => {
    setBusy(true);
    setError('');
    try {
      if (kind === 'certify') await smsCertificationApi.certify(version);
      else await smsCertificationApi.withdraw();
      onChange(await smsCertificationApi.get());
      setConfirm(null);
      toast(kind === 'certify' ? 'SMS consent confirmed' : 'SMS consent withdrawn');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sg-card" data-testid="sms-certification">
      <div className="sg-card__head">
        Text messages (SMS)
        {status.certified ? (
          <span className="sg-card__end sg-tag sg-tag--ok">Confirmed</span>
        ) : (
          <span className="sg-card__end sg-tag sg-tag--warn">Not confirmed</span>
        )}
      </div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        <p className="sg-help" style={{ marginTop: 0 }}>
          Texts to signers stay off for your organization until an owner or admin confirms this
          once.
        </p>
        <blockquote
          className="sg-note"
          data-testid="sms-certification-wording"
          style={{ margin: 0 }}
        >
          {wording}
        </blockquote>
        {status.certified ? (
          <>
            <p className="sg-help" data-testid="sms-certification-by" style={{ margin: 0 }}>
              Confirmed by {status.certified_by_name ?? 'an administrator'}
              {status.certified_at !== null ? ` on ${fmtDate(status.certified_at, true)}` : ''}.
            </p>
            <Btn
              size="sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => setConfirm('withdraw')}
              data-testid="sms-certification-withdraw"
            >
              Withdraw
            </Btn>
          </>
        ) : (
          <Btn
            variant="primary"
            size="sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setConfirm('certify')}
            data-testid="sms-certification-certify"
          >
            Certify
          </Btn>
        )}
        {error !== '' && confirm === null ? <ErrorBox>{error}</ErrorBox> : null}
      </div>
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null);
            setError('');
          }
        }}
        title={confirm === 'withdraw' ? 'Withdraw SMS consent?' : 'Confirm SMS consent?'}
        description={
          confirm === 'withdraw'
            ? 'Texts to signers turn off for your organization until an owner or admin confirms again.'
            : 'You confirm this for your whole organization. Your name and the time are recorded.'
        }
        size="sm"
        footer={
          <>
            <Btn onClick={() => setConfirm(null)}>Cancel</Btn>
            <Btn
              variant={confirm === 'withdraw' ? 'danger' : 'primary'}
              disabled={busy}
              onClick={() => void act(confirm ?? 'certify')}
              data-testid="sms-certification-confirm"
            >
              {confirm === 'withdraw' ? 'Withdraw' : 'Certify'}
            </Btn>
          </>
        }
      >
        {confirm === 'certify' ? <div className="sg-muted">{wording}</div> : null}
        {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      </Dialog>
    </section>
  );
}
