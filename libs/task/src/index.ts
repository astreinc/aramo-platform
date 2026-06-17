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
  TASK_ACTIVE_STATUS_VALUES,
  isTaskStatus,
  type TaskStatus,
  TASK_TYPE_VALUES,
  isTaskType,
  type TaskType,
  TASK_PRIORITY_VALUES,
  isTaskPriority,
  type TaskPriority,
  TASK_SOURCE_VALUES,
  isTaskSource,
  type TaskSource,
  type TaskView,
  type CreateTaskRequestDto,
  type UpdateTaskRequestDto,
} from './lib/dto/index.js';
