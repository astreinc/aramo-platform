import { Button } from '@aramo/fe-foundation';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — the one-time secret card (handoff §8.2): shows a code the
// server returns exactly once (a pilot invite code), with Copy and an explicit
// "I've saved it" dismissal. role="status" so the arrival is announced.

export interface OneTimeSecretProps {
  /** The secret to show (mono 22px). */
  readonly secret: string;
  /** Who it is for (mono). */
  readonly recipient: string;
  /** The formatted expiry ("2 Nov 2026"); omitted when the code has none. */
  readonly expires?: string | null;
  /** Called after the secret was written to the clipboard (e.g. a toast). */
  readonly onCopied?: () => void;
  readonly onDismiss: () => void;
  /** Clipboard seam (tests); default navigator.clipboard.writeText. */
  readonly writeClipboard?: (text: string) => Promise<void>;
}

export function OneTimeSecret({
  secret,
  recipient,
  expires,
  onCopied,
  onDismiss,
  writeClipboard,
}: OneTimeSecretProps) {
  const copy = (): void => {
    const write = writeClipboard ?? ((text: string) => navigator.clipboard.writeText(text));
    write(secret).then(
      () => onCopied?.(),
      () => {
        // Clipboard refused (permissions / insecure origin): the code stays on
        // screen for manual copy; nothing else to do.
      },
    );
  };
  return (
    <section role="status" className="pw-secret">
      <div className="pw-secret__warn">This code is shown only once</div>
      <div className="pw-secret__row">
        <span className="pw-secret__code" data-testid="one-time-secret">
          {secret}
        </span>
        <Button unstyled className="pw-btn pw-btn--secondary pw-btn--34" onClick={copy}>
          Copy
        </Button>
      </div>
      <div className="pw-secret__meta">
        For <span className="pw-mono">{recipient}</span>
        {expires ? (
          <>
            <br />
            Expires {expires}
          </>
        ) : null}
      </div>
      <Button unstyled className="pw-secret__dismiss" onClick={onDismiss}>
        I&apos;ve saved it — dismiss
      </Button>
    </section>
  );
}
