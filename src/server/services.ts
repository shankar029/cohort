import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Project } from '@shared/index';
import type { CreateAgentInput, CreateProjectInput } from '@shared/index';
import type { Store } from './db/store.js';
import { AGENT_CATALOG, TEAM_LEAD_TEMPLATE, getCatalogAgent } from './agents/catalog.js';

export interface ServiceConfig {
  defaultModel: string;
}

/** Validate that a path exists and is a directory (the repo to work in). */
export function validateRepoDir(
  repoDir: string,
  createIfMissing = false,
): { ok: true; resolved: string; created?: boolean } | { ok: false; error: string } {
  const resolved = path.resolve(repoDir);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return { ok: false, error: 'Path is not a directory' };
    return { ok: true, resolved };
  } catch {
    if (!createIfMissing) return { ok: false, error: 'Directory does not exist' };
    try {
      fs.mkdirSync(resolved, { recursive: true });
      return { ok: true, resolved, created: true };
    } catch (err) {
      return {
        ok: false,
        error: `Could not create directory: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      };
    }
  }
}

/** Create a project and auto-provision its Team Lead agent. */
export function createProjectWithLead(
  store: Store,
  config: ServiceConfig,
  input: CreateProjectInput,
  resolvedRepoDir: string,
): Project {
  const model = input.defaultModel?.trim() || config.defaultModel;
  const project = store.createProject({
    name: input.name,
    repoDir: resolvedRepoDir,
    settings: { defaultModel: model, approvalMode: 'auto-workspace', extraSkillRoots: [] },
  });
  store.createAgent({
    projectId: project.id,
    ...TEAM_LEAD_TEMPLATE,
    model,
  });
  store.ensureMainThread(project.id);
  return project;
}

function uniqueAgentName(store: Store, projectId: string, base: string): string {
  let name = base;
  let n = 2;
  while (store.getAgentByName(projectId, name)) {
    name = `${base}-${n++}`;
  }
  return name;
}

/** Create a specialist agent from a catalog template or from custom fields. */
export function createAgent(
  store: Store,
  config: ServiceConfig,
  projectId: string,
  input: CreateAgentInput,
): Agent {
  const model =
    input.model?.trim() ||
    store.getProject(projectId)?.settings.defaultModel ||
    config.defaultModel;

  if (input.catalogId) {
    const template = getCatalogAgent(input.catalogId);
    if (!template) throw new Error('Unknown catalog agent');
    const name = uniqueAgentName(store, projectId, input.name?.trim() || template.name);
    return store.createAgent({
      projectId,
      kind: 'specialist',
      name,
      displayName: input.displayName?.trim() || template.displayName,
      description: input.description?.trim() || template.description,
      prompt: input.prompt?.trim() || template.prompt,
      tools: input.tools !== undefined ? input.tools : template.tools,
      skills: input.skills ?? template.suggestedSkills,
      model,
      emoji: input.emoji?.trim() || template.emoji,
      color: input.color?.trim() || template.color,
      catalogId: template.id,
      status: 'idle',
    });
  }

  // Fully custom agent.
  const base =
    input.name?.trim() || (input.displayName?.trim() ? slug(input.displayName) : 'agent');
  const name = uniqueAgentName(store, projectId, base);
  return store.createAgent({
    projectId,
    kind: 'specialist',
    name,
    displayName: input.displayName?.trim() || name,
    description: input.description?.trim() || '',
    prompt:
      input.prompt?.trim() || `You are ${input.displayName?.trim() || name}, a specialist agent.`,
    tools: input.tools ?? null,
    skills: input.skills ?? [],
    model,
    emoji: input.emoji?.trim() || '🤖',
    color: input.color?.trim() || '#3b82f6',
    catalogId: null,
    status: 'idle',
  });
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  );
}

export { AGENT_CATALOG };
