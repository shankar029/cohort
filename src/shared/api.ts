import { z } from 'zod';
import {
  APPROVAL_MODES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_RECURRENCES,
  AGENT_TASK_STATUSES,
} from './domain';

/** Validation for a project's repo directory + name on creation. */
export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  repoDir: z.string().trim().min(1, 'Repository directory is required'),
  defaultModel: z.string().trim().min(1).optional(),
  /** When true, create the repository directory (recursively) if it doesn't exist. */
  createDir: z.boolean().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSettingsSchema = z.object({
  defaultModel: z.string().trim().min(1).optional(),
  approvalMode: z.enum(APPROVAL_MODES).optional(),
  extraSkillRoots: z.array(z.string().trim()).optional(),
  recordSessions: z.boolean().optional(),
  testCommand: z.string().trim().max(200).optional(),
  buildCommand: z.string().trim().max(200).optional(),
  acceptanceCommand: z.string().trim().max(200).optional(),
  name: z.string().trim().min(1).max(80).optional(),
});
export type UpdateProjectSettingsInput = z.infer<typeof updateProjectSettingsSchema>;

/** Create an agent either from a catalog template or fully custom. */
export const createAgentSchema = z.object({
  catalogId: z.string().trim().min(1).optional(),
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and dashes')
    .max(40)
    .optional(),
  displayName: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(500).optional(),
  prompt: z.string().trim().max(8000).optional(),
  tools: z.array(z.string()).nullable().optional(),
  skills: z.array(z.string()).optional(),
  model: z.string().trim().min(1).optional(),
  emoji: z.string().trim().max(8).optional(),
  color: z.string().trim().max(24).optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = createAgentSchema.omit({ catalogId: true }).partial();
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

export const createWorkItemSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(160),
  description: z.string().trim().max(4000).optional(),
  kind: z.enum(['task', 'epic']).optional(),
  priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
  status: z.enum(WORK_ITEM_STATUSES).optional(),
  assigneeAgentId: z.string().nullable().optional(),
  scheduledAt: z.number().int().positive().optional(),
  recurrence: z.enum(WORK_ITEM_RECURRENCES).optional(),
});
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;

export const updateWorkItemSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
  status: z.enum(WORK_ITEM_STATUSES).optional(),
  assigneeAgentId: z.string().nullable().optional(),
  order: z.number().optional(),
  progress: z.number().int().min(0).max(100).optional(),
});
export type UpdateWorkItemInput = z.infer<typeof updateWorkItemSchema>;

export const sendChatSchema = z.object({
  content: z.string().trim().min(1, 'Message is required').max(8000),
  /** Target conversation; defaults to the main Team Lead channel when omitted. */
  threadId: z.string().min(1).optional(),
});

export const createThreadSchema = z.object({
  topic: z.string().trim().max(120).optional(),
  workItemId: z.string().optional(),
});
export type SendChatInput = z.infer<typeof sendChatSchema>;

export const uploadFileSchema = z.object({
  name: z.string().trim().min(1).max(255),
  /** base64-encoded file contents. */
  dataBase64: z.string().min(1),
});
export type UploadFileInput = z.infer<typeof uploadFileSchema>;

export const answerQuestionSchema = z.object({
  answer: z.string().trim().min(1).max(4000),
});
export type AnswerQuestionInput = z.infer<typeof answerQuestionSchema>;

export const upsertAgentTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  status: z.enum(AGENT_TASK_STATUSES).optional(),
  workItemId: z.string().nullable().optional(),
});
export type UpsertAgentTaskInput = z.infer<typeof upsertAgentTaskSchema>;
