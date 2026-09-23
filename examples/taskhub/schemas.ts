import { z } from "zod";

export const TaskStatusSchema = z.enum(["todo", "in_progress", "done"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPrioritySchema = z.enum(["low", "medium", "high"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().optional(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  labels: z.array(z.string()).optional(),
  dueAt: z.string().optional(),
  createdAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskCreateSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  priority: TaskPrioritySchema.optional(),
  labels: z.array(z.string()).optional(),
  dueAt: z.string().optional(),
});
export type TaskCreate = z.infer<typeof TaskCreateSchema>;

export const TaskUpdateSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  labels: z.array(z.string()).optional(),
  dueAt: z.string().optional(),
});
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>;

export const TaskListSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      title: z.string(),
      description: z.string().optional(),
      status: TaskStatusSchema,
      priority: TaskPrioritySchema,
      labels: z.array(z.string()).optional(),
      dueAt: z.string().optional(),
      createdAt: z.string(),
    })
  ),
  total: z.number().int(),
});
export type TaskList = z.infer<typeof TaskListSchema>;

export const LabelSchema = z.object({
  name: z.string(),
  color: z.string().optional(),
});
export type Label = z.infer<typeof LabelSchema>;

export const LabelListSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      color: z.string().optional(),
    })
  ),
});
export type LabelList = z.infer<typeof LabelListSchema>;

export const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type Error = z.infer<typeof ErrorSchema>;
