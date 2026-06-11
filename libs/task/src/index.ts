export { TaskModule } from './lib/task.module.js';
export { TaskController } from './lib/task.controller.js';
export {
  TaskRepository,
  buildTaskVisibilityWhere,
  isOwnerVisible,
  type TaskVisibilityInputs,
} from './lib/task.repository.js';
export { PrismaService as TaskPrismaService } from './lib/prisma/prisma.service.js';

// The assignee-validation port — apps/api binds the live identity-backed
// adapter (overriding the default Stub).
export {
  TASK_ASSIGNEE_VALIDATOR,
  StubTaskAssigneeValidator,
  type TaskAssigneeValidator,
} from './lib/task-assignee.port.js';

export {
  TASK_OWNER_TYPE_VALUES,
  isTaskOwnerType,
  type TaskOwnerType,
  TASK_STATUS_VALUES,
  isTaskStatus,
  type TaskStatus,
  type TaskView,
  type CreateTaskRequestDto,
  type UpdateTaskRequestDto,
} from './lib/dto/index.js';
