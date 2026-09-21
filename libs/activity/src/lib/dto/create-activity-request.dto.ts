import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { NOTE_CATEGORY_VALUES, type NoteCategory } from './note-category.js';
import {
  NOTE_VISIBILITY_VALUES,
  type NoteVisibility,
} from './note-visibility.js';

// CreateActivityRequestDto — POST /v1/activities payload (manual entry).
// tenant_id and created_by_id are derived from AuthContext, never the body.
//
// RN-1 (LOCKED) — converted from a decorator-free interface to a validated
// CLASS so the global ValidationPipe (whitelist + forbidNonWhitelisted +
// transform) actually bounds this route. Before RN-1 the metatype was an
// interface, so the pipe had no schema and `notes` was length-unbounded at
// every layer (FE/DTO/DB). D-6 closes that: `notes` is bounded 1..20000 here.
//
// The pipeline_status_change kind is NOT permitted on this manual route; it is
// emitted only via insertActivityInTx inside the pipeline transition. Manual
// entries are restricted to the recruiter-authored kinds.
//
// The note attributes (category/visibility/pinned) apply when type=note; for
// call/email_logged they are ignored server-side. body_format is NOT accepted
// from the client (D-5 — server-set plain_text only).
export class CreateActivityRequestDto {
  @IsIn(['note', 'call', 'email_logged'])
  type!: 'note' | 'call' | 'email_logged';

  @IsOptional()
  @IsString()
  subject_type?: string;

  @IsOptional()
  @IsUUID()
  subject_id?: string;

  // D-6 — bounded when present (1..20000). Note-body-required for type=note is
  // enforced in the create path (a note cannot be empty), not here, so that
  // call/email_logged may omit it.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  notes?: string;

  @IsOptional()
  @IsUUID()
  site_id?: string;

  // RN-1 note category (D-1). Default GENERAL applied server-side when absent.
  @IsOptional()
  @IsIn(NOTE_CATEGORY_VALUES)
  category?: NoteCategory;

  // RN-1 note visibility (D-2). Default TEAM applied server-side when absent.
  // RESTRICTED is not a value in RN-1 (Q1) — @IsIn rejects it.
  @IsOptional()
  @IsIn(NOTE_VISIBILITY_VALUES)
  visibility?: NoteVisibility;

  // RN-1 pin-on-create (D-3). When true, the note is pinned at creation with
  // provenance (pinned_at/pinned_by_id) and a PINNED event is appended.
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}
