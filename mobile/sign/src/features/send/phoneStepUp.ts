// SIGN-FREE-PARITY-1 S2 — the sender's own phone step-up (the web's Review & send has the
// same panel). The server decides whether self-serve is on and checks the code; the copy
// and the code rule come from @aramo/sign-client.
//   GET  /v1/sign/personal/step-up/status → { available, required, phone_masked }
//   POST /v1/sign/personal/step-up/send   { phone? } → { sent, phone_masked, expires_in_seconds, resend_after_seconds }
//   POST /v1/sign/personal/step-up/verify { code }   → { verified: true }
import type { components } from '../../api/generated/sign';
import type { WorkspaceClient } from '../../api/workspaceClient';

export type StepUpStatus = components['schemas']['SenderPhoneStepUpStatus'];
export type StepUpSent = components['schemas']['SenderPhoneStepUpSent'];

export async function loadStepUpStatus(workspace: WorkspaceClient): Promise<StepUpStatus> {
  return workspace.call('/v1/sign/personal/step-up/status', 'get', {});
}

export async function sendStepUpCode(workspace: WorkspaceClient, phone?: string): Promise<StepUpSent> {
  return workspace.call('/v1/sign/personal/step-up/send', 'post', {
    body: phone !== undefined && phone.trim() !== '' ? { phone: phone.trim() } : {},
  });
}

export async function verifyStepUpCode(workspace: WorkspaceClient, code: string): Promise<void> {
  await workspace.call('/v1/sign/personal/step-up/verify', 'post', { body: { code } });
}
