import type { WorkItem } from '@shared/index';

export interface EpicRef {
  id: string;
  title: string;
}

/** Build a lookup once, then resolve any work item id (epic or task) to its epic. */
export function epicOfWorkItem(
  byId: Map<string, WorkItem>,
  workItemId: string | null | undefined,
): EpicRef | null {
  if (!workItemId) return null;
  const wi = byId.get(workItemId);
  if (!wi) return null;
  const epicId = wi.kind === 'epic' ? wi.id : wi.parentId;
  if (!epicId) return null;
  return { id: epicId, title: byId.get(epicId)?.title ?? 'Epic' };
}

/** All epics in a work-item list, newest first isn't guaranteed — preserves input order. */
export function listEpics(workItems: WorkItem[]): WorkItem[] {
  return workItems.filter((w) => w.kind === 'epic');
}
