import { IsIn, IsOptional, IsString } from 'class-validator';

import { EXPORT_ENTITY_TYPES, type ExportEntityType } from '../field-catalog.js';

// PR-A8-4 — request DTOs.
//
// The path param `entity_type` is validated against EXPORT_ENTITY_TYPES
// (the catalog's enumeration) — anything else → 400 VALIDATION_ERROR
// via the global ValidationPipe (whitelist: true, forbidNonWhitelisted:
// true; the AppModule wires this).
//
// The query params are kept minimal at this batch:
//   - `columns` — comma-separated list. Empty / absent → default
//     (all ATS fields). An unknown column → 400 VALIDATION_ERROR.
//   - `site_id` — site-axis filter (the @RequireSiteMatch decorator
//     enforces the JWT site claim matches; the controller forwards
//     this into the service's row predicate).
//   - `limit` — optional cap. Default 5000; max 10_000 (the cap
//     prevents an accidental whole-tenant slurp from a recruiter
//     account; an actual bulk export pipeline at a later PR will use
//     a streaming endpoint, not this CSV-string return).

export class ExportEntityPathDto {
  @IsString()
  @IsIn(EXPORT_ENTITY_TYPES as readonly string[])
  entity_type!: ExportEntityType;
}

export class ExportQueryDto {
  @IsOptional()
  @IsString()
  columns?: string;

  @IsOptional()
  @IsString()
  site_id?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}
