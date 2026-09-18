import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

// SKILL-TAX-1F-B2 — request DTOs for the platform skill-governance surface. Shape
// checks only; normalization, uniqueness translation and lifecycle legality live in
// the skills-taxonomy SkillRegistryService / SkillGovernanceService.

const ALIAS_TYPES = ['ABBREVIATION', 'COMMON_NAME', 'LEGACY_NAME', 'VENDOR_VARIANT', 'SPELLING_VARIANT'] as const;
const RELATIONSHIP_TYPES = ['RELATED_TO', 'COMPATIBLE_WITH', 'PARENT_OF', 'BUILT_ON', 'REQUIRES', 'SUPERSEDES'] as const;
const RELATIONSHIP_SOURCES = ['VENDOR_DOC', 'ADMIN_CURATED', 'IMPORTED_TAXONOMY', 'AI_RECOMMENDED'] as const;
const PROPOSAL_TYPES = ['ALIAS', 'RELATIONSHIP'] as const;
const PROPOSAL_SOURCES = ['AI_RECOMMENDED'] as const;

export class CreateSkillDto {
  @IsString() @MaxLength(200) canonical_name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
}

export class UpdateSkillDto {
  @IsOptional() @IsString() @MaxLength(200) canonical_name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
}

export class AddAliasDto {
  @IsString() @MaxLength(200) alias!: string;
  @IsIn(ALIAS_TYPES) alias_type!: (typeof ALIAS_TYPES)[number];
}

export class AddVersionDto {
  @IsString() @MaxLength(100) version!: string;
  @IsOptional() @IsString() @MaxLength(100) version_family?: string | null;
}

export class UpdateVersionDto {
  @IsOptional() @IsString() @MaxLength(100) version_family?: string | null;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
}

export class AddRelationshipDto {
  @IsUUID() target_skill_id!: string;
  @IsIn(RELATIONSHIP_TYPES) relationship_type!: (typeof RELATIONSHIP_TYPES)[number];
  @IsIn(RELATIONSHIP_SOURCES) source!: (typeof RELATIONSHIP_SOURCES)[number];
  @IsOptional() @IsString() @MaxLength(500) source_ref?: string | null;
}

export class MergeSkillDto {
  @IsUUID() winner_skill_id!: string;
}

export class OverrideSkillDto {
  // Governed free-form correction note surface (JSON-safe string map). The service
  // treats a `surface_form` key specially (keys the OVERRIDE_CORRECTION by form).
  @IsOptional() @IsString() @MaxLength(200) surface_form?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string | null;
}

export class CreateProposalDto {
  @IsIn(PROPOSAL_TYPES) proposal_type!: (typeof PROPOSAL_TYPES)[number];
  @IsIn(PROPOSAL_SOURCES) source!: (typeof PROPOSAL_SOURCES)[number];
  // The proposed spec — validated for the type at ACCEPT time (never applied on create).
  @IsObject() payload!: Record<string, unknown>;
}

export class RejectProposalDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string | null;
}

export class ReviewQueueQueryDto {
  @IsOptional() @IsIn(['talent', 'requisition']) source_domain?: 'talent' | 'requisition';
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) min_occurrence?: number;
  @IsOptional() @IsString() @MaxLength(200) surface_search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @IsString() @MaxLength(2000) cursor?: string;
}

export class ListSkillsQueryDto {
  @IsOptional() @IsIn(['true', 'false']) include_inactive?: 'true' | 'false';
}

export class ListProposalsQueryDto {
  @IsOptional() @IsIn(['PENDING', 'ACCEPTED', 'REJECTED']) status?: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}
