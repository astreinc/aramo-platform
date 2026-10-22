import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { TalentEducationEntryRequestDto } from './dto/talent-education.dto.js';
import type { TalentEducationChangeView } from './dto/talent-360.view.js';
import { TalentEducationService } from './talent-education.service.js';

// ATS-QA-1 I-4 (L2, amendment A3) — recruiter edit of a Talent's declared
// education. Nested under the talent-record resource (the record is the subject),
// gated like every other Talent edit: capability `ats` + scope `talent:edit`.
// The current education is READ through the Talent 360 response
// (profile.education); each write returns the Talent's current education.
//   POST   …/education             add a manual entry
//   PUT    …/education/:entryId    correct an entry (new manual entry, old retired)
//   DELETE …/education/:entryId    remove an entry (retired, kept as history)
// Nothing is overwritten or deleted. tenant + actor come ONLY from the JWT.
// Missing / cross-tenant Talent or entry → 404; superseded record → 422;
// an entry already corrected or removed → 409.
@Controller('v1/talent-records/:recordId/education')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TalentEducationController {
  constructor(private readonly service: TalentEducationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async add(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() body: TalentEducationEntryRequestDto,
  ): Promise<TalentEducationChangeView> {
    return this.service.add(actorOf(authContext, requestId), recordId, body);
  }

  @Put(':entryId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async correct(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() body: TalentEducationEntryRequestDto,
  ): Promise<TalentEducationChangeView> {
    return this.service.correct(actorOf(authContext, requestId), recordId, entryId, body);
  }

  @Delete(':entryId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:edit')
  @RequireSiteMatch()
  async remove(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ): Promise<TalentEducationChangeView> {
    return this.service.remove(actorOf(authContext, requestId), recordId, entryId);
  }
}

function actorOf(authContext: AuthContextType, requestId: string) {
  return { tenant_id: authContext.tenant_id, user_id: authContext.sub, request_id: requestId };
}
