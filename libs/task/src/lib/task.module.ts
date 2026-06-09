import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { PrismaService } from './prisma/prisma.service.js';
import { TaskController } from './task.controller.js';
import { TaskRepository } from './task.repository.js';
import {
  TASK_ASSIGNEE_VALIDATOR,
  StubTaskAssigneeValidator,
} from './task-assignee.port.js';

// TaskModule — Tasks backend (the last core recruiter surface).
//
// LEAF import set (lint:nx-boundaries — directional edges only):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//
// Deliberately leaf: NO @aramo/identity edge (the assignee check goes through
// the TASK_ASSIGNEE_VALIDATOR port — apps/api binds the identity-backed
// adapter, the S3a/S4 port precedent). NO @aramo/visibility edge (the
// resolvers are attached to the request by the global VisibilityInterceptor;
// the controller consumes them via req, the activity precedent). The default
// provider here is the Stub; apps/api OVERRIDES the port with the live adapter.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [TaskController],
  providers: [
    PrismaService,
    TaskRepository,
    { provide: TASK_ASSIGNEE_VALIDATOR, useClass: StubTaskAssigneeValidator },
  ],
  exports: [TaskRepository],
})
export class TaskModule {}
