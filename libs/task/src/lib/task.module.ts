import {
  DynamicModule,
  Module,
  Type,
  type ModuleMetadata,
} from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { PrismaService } from './prisma/prisma.service.js';
import { TaskController } from './task.controller.js';
import { TaskRepository } from './task.repository.js';
import {
  TASK_ASSIGNEE_VALIDATOR,
  UnboundTaskAssigneeValidator,
  type TaskAssigneeValidator,
} from './task-assignee.port.js';

// Options for TaskModule.forRoot — the composition-root entry point.
// assigneeValidator is the live TaskAssigneeValidator implementation
// (apps/api's IdentityService-backed TaskAssigneeAdapter). Required:
// TypeScript rejects forRoot({}) at compile time, so a real-adapter
// omission can never silently degrade to the accept-any stub.
//
// imports threads the module(s) that PROVIDE assigneeValidator's own
// dependencies into TaskModule's dynamic scope — apps/api's TaskAssigneeAdapter
// injects IdentityService, so apps/api passes [IdentityModule] (which exports
// it). This is the divergence from the cognito forRoot: that adapter has a
// no-arg constructor, so its useClass binding needed no extra scope; this one
// does. libs/task stays LEAF — it never names IdentityModule; the importer
// threads it through as an opaque ModuleMetadata['imports'] entry. Optional:
// a dependency-free validator (e.g. a test double) needs no imports.
export interface TaskModuleOptions {
  assigneeValidator: Type<TaskAssigneeValidator>;
  imports?: ModuleMetadata['imports'];
}

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
// the controller consumes them via req, the activity precedent).
//
// Two-entry-point dynamic module (Task-Assignee Binding-Fix v1.0 — the
// ratified cognito forRoot shape). apps/api — the SOLE importer — imports via
// TaskModule.forRoot({ assigneeValidator }), which appends a same-token
// provider to THIS module's own scope (last-wins) so TaskController (a
// CONTROLLER of this module — controllers resolve against their host module's
// scope, identically to providers) resolves the LIVE adapter. The earlier
// defect was an AppModule-scoped override that never reached TaskModule's
// scope (NestJS DI is per-module hierarchical, not global last-wins;
// TaskModule is not @Global) — so TaskController got the accept-any stub and
// the R5 active-within-tenant assignee check silently passed for ANY assignee.
//
// The @Module default below is the fail-CLOSED UnboundTaskAssigneeValidator
// (throws on call): there are no plain-import siblings, so this only guards an
// accidental future plain import — it fails SAFE, never accept-any-open.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [TaskController],
  providers: [
    PrismaService,
    TaskRepository,
    { provide: TASK_ASSIGNEE_VALIDATOR, useClass: UnboundTaskAssigneeValidator },
  ],
  exports: [TaskRepository],
})
export class TaskModule {
  // forRoot is for the composition root that OWNS the real assignee adapter —
  // apps/api ONLY. It returns a DynamicModule that NestJS MERGES with the
  // @Module decorator above: the dynamic provider for TASK_ASSIGNEE_VALIDATOR
  // is appended to this module's own providers, so it shadows the fail-closed
  // default (last-wins within a single module's scope) and binds IN
  // TaskModule's scope, which is where TaskController resolves the token.
  // assigneeValidator is REQUIRED — omission is a compile error, never a
  // silent runtime fallback to the stub.
  static forRoot(options: TaskModuleOptions): DynamicModule {
    return {
      module: TaskModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: TASK_ASSIGNEE_VALIDATOR,
          useClass: options.assigneeValidator,
        },
      ],
    };
  }
}
