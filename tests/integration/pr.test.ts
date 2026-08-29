import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';
import { FakeCopilotAdapter } from '../../src/server/agents/fakeAdapter.js';
import type { AgentSession, AgentSessionConfig } from '../../src/server/agents/adapter.js';
import type { PullRequest } from '../../src/shared/index.js';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-prrepo-'));
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  rmDir(repoDir);
});

async function createProject(name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, repoDir },
  });
  return (res.json() as { project: { id: string } }).project.id;
}

async function addSpecialist(projectId: string, catalogId: string): Promise<void> {
  await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    payload: { catalogId },
  });
}

describe('PR + review + iterate-to-quality (Phase 4)', () => {
  it('files review comments, assigns fixes, then approves and merges once resolved', async () => {
    const projectId = await createProject('PR Flow');
    await addSpecialist(projectId, 'frontend-engineer');
    // A reviewer whose persona files one routed review comment (deduped across rounds).
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents`,
      payload: {
        name: 'reviewer',
        displayName: 'Code Reviewer',
        prompt: 'You review pull requests. [[REVIEW_COMMENT: frontend | add tests for edge cases]]',
      },
    });

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a profile page.' },
    });

    // The reviewer files a comment → the PR requests changes.
    await ctx.waitFor(
      (m) => m.type === 'pull_request.updated' && m.pr.status === 'changes_requested',
      12000,
    );

    // The Team Lead assigned a fix task for the comment.
    const commentAssigned = (await ctx.waitFor(
      (m) => m.type === 'pr_comment.updated' && m.comment.workItemId != null,
      12000,
    )) as { type: 'pr_comment.updated'; comment: { workItemId: string | null } };
    expect(commentAssigned.comment.workItemId).toBeTruthy();

    // After the rework, the PR is approved and merged.
    const merged = (await ctx.waitFor(
      (m) => m.type === 'pull_request.updated' && m.pr.status === 'merged',
      12000,
    )) as { type: 'pull_request.updated'; pr: PullRequest };
    expect(merged.pr.branch).toMatch(/^ateam\/epic-/);

    // The epic is closed.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' && m.workItem.kind === 'epic' && m.workItem.status === 'done',
      12000,
    );

    // The epic branch was really merged into the base branch.
    const log = execFileSync('git', ['log', '--oneline', '--merges'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    expect(log).toMatch(/merge ateam\/epic-/i);

    const pulls = ctx.store.listPRs(projectId);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.status).toBe('merged');

    // Every review comment ended up resolved before the merge.
    const comments = ctx.store.listProjectPrComments(projectId);
    expect(comments.length).toBeGreaterThanOrEqual(1);
    expect(comments.every((c) => c.status === 'resolved')).toBe(true);
  });

  it('feeds the ORIGINAL request into the reviewer prompt (I7)', async () => {
    // A recorder adapter captures every prompt sent to any agent session.
    class PromptRecorderAdapter extends FakeCopilotAdapter {
      prompts: string[] = [];
      override async createAgentSession(config: AgentSessionConfig): Promise<AgentSession> {
        const session = await super.createAgentSession(config);
        const orig = session.ask.bind(session);
        session.ask = async (prompt: string, messageId: string): Promise<string> => {
          this.prompts.push(prompt);
          return orig(prompt, messageId);
        };
        return session;
      }
    }
    const rec = new PromptRecorderAdapter();
    const app2 = createTestApp([], rec);
    try {
      const res = await app2.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Review Anchoring', repoDir },
      });
      const projectId = (res.json() as { project: { id: string } }).project.id;
      await app2.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/agents`,
        payload: { catalogId: 'frontend-engineer' },
      });
      await app2.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/agents`,
        payload: {
          name: 'reviewer',
          displayName: 'Code Reviewer',
          prompt: 'You review pull requests.',
        },
      });

      const PHRASE = 'Zircon-in-memory-no-deps-marker';
      await app2.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/chat`,
        payload: { content: `Build a headless widget. Constraint: ${PHRASE}.` },
      });

      // Wait until the PR reaches a terminal review state (merged or changes).
      await app2.waitFor(
        (m) =>
          m.type === 'pull_request.updated' &&
          (m.pr.status === 'merged' || m.pr.status === 'changes_requested'),
        15000,
      );
      const reviewPrompt = rec.prompts.find((p) => /Please review the pull request/.test(p));
      expect(reviewPrompt).toBeTruthy();
      expect(reviewPrompt).toContain(PHRASE);
      expect(reviewPrompt).toMatch(/HARD CONSTRAINTS/);
    } finally {
      await app2.close();
    }
  });
});
