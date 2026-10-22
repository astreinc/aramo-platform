import { apiClient } from '@aramo/fe-foundation';

import type { EducationEntryView } from '../talent-360/talent-360-types';

// ATS-QA-1 I-4 (L2) — recruiter education edit. The current education is read
// through GET /v1/talent-360/:id (profile.education); each write returns the
// Talent's current education. Requires talent:edit. Nothing is overwritten or
// deleted on the server: a correction writes a new entry and retires the old one,
// a removal retires the entry (both kept as history).

export interface EducationEntryInput {
  readonly institution_name: string;
  readonly degree_name: string;
  /** '' or null = not stated. */
  readonly field_of_study?: string | null;
  /** YYYY-MM-DD; '' or null = not stated. */
  readonly conferred_date?: string | null;
}

export interface EducationChangeResponse {
  readonly entry_id: string;
  readonly education: readonly EducationEntryView[];
}

const base = (talentId: string): string =>
  `/v1/talent-records/${encodeURIComponent(talentId)}/education`;

export async function addTalentEducation(
  talentId: string,
  body: EducationEntryInput,
): Promise<EducationChangeResponse> {
  return apiClient.post<EducationChangeResponse>(base(talentId), body);
}

export async function correctTalentEducation(
  talentId: string,
  entryId: string,
  body: EducationEntryInput,
): Promise<EducationChangeResponse> {
  return apiClient.put<EducationChangeResponse>(`${base(talentId)}/${encodeURIComponent(entryId)}`, body);
}

export async function removeTalentEducation(
  talentId: string,
  entryId: string,
): Promise<EducationChangeResponse> {
  return apiClient.delete<EducationChangeResponse>(`${base(talentId)}/${encodeURIComponent(entryId)}`);
}

/** Recruiter-facing source label for an education entry. */
export function educationSourceLabel(e: Pick<EducationEntryView, 'source' | 'corrects_entry_id'>): string {
  if (e.source === 'manual') return e.corrects_entry_id !== null ? 'Corrected by a recruiter' : 'Entered manually';
  if (e.source === 'import') return 'Imported';
  return 'From resume';
}
