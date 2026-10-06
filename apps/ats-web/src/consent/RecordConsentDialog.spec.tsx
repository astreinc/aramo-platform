import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@aramo/fe-foundation';

import { RecordConsentDialog } from './RecordConsentDialog';
import * as api from './consent-api';
import type { ConsentCaptureMethod } from './types';

// PO RULING "Consent Capture" — FE proofs for the ONE reusable capture dialog.
// The api module is mocked; the Dialog + form render REAL (SiteDialog pattern).

vi.mock('./consent-api');

function texts(method: ConsentCaptureMethod) {
  return {
    version: method === 'recruiter_capture' ? 'recruiter-capture-v1-draft' : 'portal-consent-v1',
    captured_method: method,
    texts: [
      { scope: 'profile_storage' as const, text: `[${method}] store clause` },
      { scope: 'matching' as const, text: `[${method}] matching clause` },
      { scope: 'contacting' as const, text: `[${method}] contacting clause` },
    ],
  };
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof RecordConsentDialog>> = {},
) {
  return render(
    <ToastProvider>
      <RecordConsentDialog
        talentRecordId="t-1"
        open
        onOpenChange={() => undefined}
        {...props}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getConsentCaptureTexts).mockImplementation((m) =>
    Promise.resolve(texts(m)),
  );
  vi.mocked(api.captureConsent).mockResolvedValue({
    talent_record_id: 't-1',
    captured_method: 'recruiter_capture',
    consent_version: 'recruiter-capture-v1-draft',
    results: [],
  });
});

afterEach(() => vi.clearAllMocks());

describe('RecordConsentDialog', () => {
  it('loads and displays the server-rendered versioned statement (recruiter default)', async () => {
    renderDialog();
    expect(await screen.findByText(/recruiter-capture-v1-draft/)).toBeTruthy();
    expect(screen.getByText('[recruiter_capture] contacting clause')).toBeTruthy();
    expect(api.getConsentCaptureTexts).toHaveBeenCalledWith('recruiter_capture');
  });

  it('surfaces an explicit error when the consent statement cannot load', async () => {
    vi.mocked(api.getConsentCaptureTexts).mockRejectedValueOnce(new Error('network'));
    renderDialog();
    expect(
      await screen.findByText(/Could not load the consent statement/),
    ).toBeTruthy();
  });

  it('records exactly the affirmatively-selected scopes (all three by default)', async () => {
    renderDialog();
    await screen.findByText(/recruiter-capture-v1-draft/);
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));
    await waitFor(() =>
      expect(api.captureConsent).toHaveBeenCalledWith({
        talent_record_id: 't-1',
        captured_method: 'recruiter_capture',
        scopes: ['profile_storage', 'matching', 'contacting'],
      }),
    );
  });

  it('enforces dependency closure — unchecking profile_storage clears its dependents', async () => {
    renderDialog();
    await screen.findByText(/recruiter-capture-v1-draft/);
    const profile = screen.getByRole('checkbox', {
      name: 'Store and maintain this Talent profile',
    });
    fireEvent.click(profile); // uncheck the root prerequisite
    expect(
      (screen.getByRole('checkbox', { name: 'Use this profile for job matching' }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (screen.getByRole('checkbox', {
        name: 'Contact this Talent regarding recruiting opportunities',
      }) as HTMLInputElement).checked,
    ).toBe(false);
    // Nothing selected → the submit is disabled (an empty/invalid set is never sent).
    expect(
      (screen.getByRole('button', { name: 'Record consent' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('records a partial-but-valid set (drop contacting, keep its prerequisites)', async () => {
    renderDialog();
    await screen.findByText(/recruiter-capture-v1-draft/);
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Contact this Talent regarding recruiting opportunities',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));
    await waitFor(() =>
      expect(api.captureConsent).toHaveBeenCalledWith({
        talent_record_id: 't-1',
        captured_method: 'recruiter_capture',
        scopes: ['profile_storage', 'matching'],
      }),
    );
  });

  it('switches to the approved first-person text for the Talent-direct method', async () => {
    renderDialog();
    await screen.findByText(/recruiter-capture-v1-draft/);
    fireEvent.click(screen.getByRole('radio', { name: 'Talent directly' }));
    expect(await screen.findByText(/portal-consent-v1/)).toBeTruthy();
    expect(screen.getByText('[self_signup] contacting clause')).toBeTruthy();
    expect(api.getConsentCaptureTexts).toHaveBeenCalledWith('self_signup');
  });

  it('on success invokes onRecorded and closes', async () => {
    const onRecorded = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog({ onRecorded, onOpenChange });
    await screen.findByText(/recruiter-capture-v1-draft/);
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('surfaces a failed record WITHOUT a false success', async () => {
    vi.mocked(api.captureConsent).mockRejectedValueOnce(new Error('boom'));
    const onRecorded = vi.fn();
    renderDialog({ onRecorded });
    await screen.findByText(/recruiter-capture-v1-draft/);
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));
    expect(await screen.findByText(/Consent could not be recorded/)).toBeTruthy();
    expect(onRecorded).not.toHaveBeenCalled();
  });
});
