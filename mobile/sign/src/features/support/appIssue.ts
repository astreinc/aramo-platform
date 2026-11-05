// M-A12 W1-E.3 — Report app issue: POST /v1/sign/me/app-issues (contract §3)
//   { message (1..2000), app_version, os ("ios"|"android"), os_version, device_model, screen? }
// → 202; 5 per user per hour (429). Exactly these properties are sent: the user's own
// words plus the app version, OS, OS version, device model and the screen name. No
// document data, no tokens, no logs are attached.
import { isApiError } from '../../api/errors';
import type { AppIssueReport } from '../../api/m-a12-contract-types';
import type { WorkspaceClient } from '../../api/workspaceClient';

export const ISSUE_MAX = 2000;

export const ISSUE_COPY = {
  sent: 'Thanks. Your report was sent to Aramo support.',
  tooMany: 'You’ve sent several reports in the last hour. Try again later.',
  failed: 'Couldn’t send your report. Check your connection and try again.',
  note: 'We send your message with the app version, the phone’s system and model, and the screen you were on. No documents or account data are attached.',
} as const;

export interface DeviceFacts {
  readonly appVersion: string | null;
  readonly os: string;
  readonly osVersion: string | number | null;
  readonly deviceModel: string | null;
}

/** The exact body sent: these keys and nothing else (the server refuses extras). */
export function issueBody(message: string, facts: DeviceFacts, screen?: string): AppIssueReport {
  const os = facts.os === 'ios' ? 'ios' : 'android';
  return {
    message: message.trim().slice(0, ISSUE_MAX),
    app_version: facts.appVersion ?? '0.0.0',
    os,
    os_version: String(facts.osVersion ?? ''),
    device_model: facts.deviceModel ?? 'unknown',
    ...(screen ? { screen: screen.slice(0, 100) } : {}),
  };
}

export function validIssue(message: string): boolean {
  const n = message.trim().length;
  return n >= 1 && n <= ISSUE_MAX;
}

export async function sendAppIssue(
  workspace: WorkspaceClient,
  body: AppIssueReport,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await workspace.request<unknown>({ method: 'POST', path: '/v1/sign/me/app-issues', body });
    return { ok: true };
  } catch (e) {
    if (isApiError(e) && e.status === 429) return { ok: false, message: ISSUE_COPY.tooMany };
    return { ok: false, message: ISSUE_COPY.failed };
  }
}
