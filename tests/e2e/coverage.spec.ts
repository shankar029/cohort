import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Thorough, screenshot-capturing tour of every feature/page, running against the
 * isolated fake-SDK harness (see playwright.config.ts). Screenshots land in
 * test-results/coverage/ for manual review.
 */

const SHOTS = path.join(process.cwd(), 'test-results', 'coverage');
fs.mkdirSync(SHOTS, { recursive: true });
let shotN = 0;
async function shot(page: Page, name: string): Promise<void> {
  shotN += 1;
  const file = path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
}

function makeRepoDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-e2e-'));
}

async function createProject(page: Page, name: string): Promise<void> {
  const repoDir = makeRepoDir();
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill(name);
  await page.getByTestId('project-repo').fill(repoDir);
  await page.getByTestId('project-submit').click();
  await expect(page.getByTestId('add-agent')).toBeVisible();
}

async function addSpecialist(page: Page, catalogId: string): Promise<void> {
  await page.getByTestId('add-agent').click();
  await page.getByTestId(`add-catalog-${catalogId}`).click();
  await expect(page.getByTestId(`added-${catalogId}`)).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('agent-list')).toBeVisible();
}

async function nav(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name, exact: true }).click();
}

// ---------------------------------------------------------------- Projects + Dashboard
test('projects + dashboard: create, land on dashboard, KPI cards', async ({ page }) => {
  await page.goto('/');
  await shot(page, 'projects-empty');
  await createProject(page, 'Cov Dashboard');

  await nav(page, 'Dashboard');
  await expect(page.getByTestId('kpi-card').first()).toBeVisible();
  await shot(page, 'dashboard');

  // Project appears in the picker + projects landing.
  await page.goto('/');
  await expect(page.getByTestId('project-card').filter({ hasText: 'Cov Dashboard' })).toBeVisible();
  await shot(page, 'projects-list');
});

// ---------------------------------------------------------------- Agents (catalog/custom/edit/detail)
test('agents: catalog add, custom agent, edit, and agent detail surfaces', async ({ page }) => {
  await createProject(page, 'Cov Agents');

  // Catalog grid + add specialist.
  await page.getByTestId('add-agent').click();
  await expect(page.getByTestId('catalog-grid')).toBeVisible();
  await shot(page, 'agents-catalog');
  await page.getByTestId('add-catalog-frontend-engineer').click();
  await expect(page.getByTestId('added-frontend-engineer')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('agent-list')).toContainText('Frontend Engineer');

  // Custom agent tab.
  await page.getByTestId('add-agent').click();
  await page.getByTestId('tab-custom').click();
  await page.getByTestId('custom-name').fill('perf-specialist');
  await page.getByTestId('custom-submit').click();
  await expect(page.getByTestId('agent-list')).toContainText('perf-specialist');
  await shot(page, 'agents-list');

  // Edit an agent.
  await page.getByTestId('agent-card').filter({ hasText: 'Frontend Engineer' }).click();
  await page.getByTestId('edit-agent').click();
  await expect(page.getByTestId('agent-editor')).toBeVisible();
  await shot(page, 'agent-edit');
  await page.getByTestId('save-agent').click();

  // Agent detail: task board / notes / plan / log exist (may be empty pre-work).
  await expect(page.getByTestId('scratchpad').or(page.getByTestId('agent-notes'))).toBeVisible();
  await shot(page, 'agent-detail');
});

test('agents: duplicate catalog add is blocked, and remove works from the list', async ({
  page,
}) => {
  await createProject(page, 'Cov Agents Dup');

  await page.getByTestId('add-agent').click();
  await page.getByTestId('add-catalog-frontend-engineer').click();
  // The card flips to “Added” so it can't be added again, and the panel stays open.
  await expect(page.getByTestId('added-frontend-engineer')).toBeVisible();
  await expect(page.getByTestId('add-catalog-frontend-engineer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('agent-list')).toContainText('Frontend Engineer');

  // Remove it from the Agents list (confirm dialog auto-accepted).
  page.on('dialog', (d) => void d.accept());
  await page.getByTestId('remove-agent').first().click();
  await expect(page.getByTestId('remove-agent')).toHaveCount(0);
  await expect(page.getByText('No specialists yet')).toBeVisible();
});

// ---------------------------------------------------------------- Board (item, filter, detail, progress)
test('board: create item, columns, epic filter, detail modal + progress', async ({ page }) => {
  await createProject(page, 'Cov Board');
  await addSpecialist(page, 'frontend-engineer');

  // Generate an epic via chat so the epic-filter dropdown renders.
  await nav(page, 'Threads');
  await page.getByTestId('chat-input').fill('Please build a settings panel.');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('lead-message').last()).toBeVisible({ timeout: 20000 });

  await nav(page, 'Board');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('workitem').first()).toBeVisible({ timeout: 20000 });
  // Time + token usage accrues on the epic card as the team works it.
  await expect(page.getByTestId('usage-chip').first()).toBeVisible({ timeout: 20000 });
  // The deterministic verification gate badge appears on worked cards (pushed live).
  await expect(page.getByTestId('gate-badge').first()).toBeVisible({ timeout: 25000 });

  // Create an additional assigned item.
  await page.getByTestId('add-workitem').click();
  await page.locator('input#wi-title').fill('Design the landing hero');
  await page.getByTestId('workitem-assignee').selectOption({ label: '🖥️ Frontend Engineer' });
  await page.getByTestId('workitem-submit').click();
  await expect(page.getByTestId('board')).toContainText('Design the landing hero');

  // Epic filter dropdown is present (epics exist).
  await expect(page.getByTestId('epic-filter')).toBeVisible();
  await shot(page, 'board');

  // Open the detail modal (title button inside the card) and confirm it renders.
  const card = page.getByTestId('workitem').filter({ hasText: 'Design the landing hero' }).first();
  await card.getByRole('button', { name: 'Design the landing hero' }).click();
  await expect(page.getByTestId('workitem-detail')).toBeVisible();
  await shot(page, 'board-detail');
});

// ---------------------------------------------------------------- Chat (epic, threads, markdown, escalation)
test('chat: build request → Lead reply + specialist contribution + threads/markdown', async ({
  page,
}) => {
  await createProject(page, 'Cov Chat');
  await addSpecialist(page, 'frontend-engineer');

  await nav(page, 'Threads');
  await page.getByTestId('chat-input').fill('Please build the header component.');
  await page.getByTestId('chat-send').click();

  await expect(page.getByTestId('lead-message').last()).toBeVisible({ timeout: 20000 });
  // The epic's delivery discussion lands in its own thread, grouped under the epic.
  const epicThread = page.getByTestId('thread-item').filter({ hasText: 'Team discussion' });
  await expect(epicThread).toBeVisible({ timeout: 20000 });
  await epicThread.click();
  await expect(page.getByTestId('agent-message').first()).toContainText('Frontend Engineer', {
    timeout: 20000,
  });
  await expect(page.getByTestId('markdown').first()).toBeVisible();
  await expect(page.getByTestId('thread-list')).toBeVisible();
  await shot(page, 'chat');
});

test('chat escalation: a question surfaces and answering resumes the work', async ({ page }) => {
  await createProject(page, 'Cov Escalation');
  await addSpecialist(page, 'backend-engineer');

  await nav(page, 'Board');
  await page.getByTestId('add-workitem').click();
  await page.getByTestId('workitem-title').fill('Ambiguous API [[ASK_USER]]');
  await page.getByTestId('workitem-assignee').selectOption({ label: '⚙️ Backend Engineer' });
  await page.getByTestId('workitem-submit').click();

  await nav(page, 'Threads');
  await expect(page.getByTestId('question-card')).toBeVisible({ timeout: 20000 });
  await shot(page, 'chat-question');
  // BUG-3: a question with preset choices must STILL offer a free-text answer.
  await expect(page.getByTestId('question-choice').first()).toBeVisible();
  await expect(page.getByTestId('question-answer-input')).toBeVisible();
  await page.getByTestId('question-answer-input').fill('Use REST with cursor pagination');
  await page.getByRole('button', { name: 'Answer' }).click();

  await nav(page, 'Board');
  await expect(page.getByTestId('column-review')).toContainText('Ambiguous API', {
    timeout: 20000,
  });
});

// ---------------------------------------------------------------- Git (branches, commits, PR, merge)
test('git: completed epic shows a branch, commits and a merged PR', async ({ page }) => {
  await createProject(page, 'Cov Git');
  await addSpecialist(page, 'frontend-engineer');
  await addSpecialist(page, 'qa-engineer');

  await nav(page, 'Threads');
  await page.getByTestId('chat-input').fill('Please build a profile page.');
  await page.getByTestId('chat-send').click();

  await nav(page, 'Git');
  await expect(page.getByTestId('git-epic').first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('git-epic').first()).toContainText('ateam/epic-', {
    timeout: 30000,
  });
  await expect(page.getByTestId('pr-card').first()).toContainText('Merged', { timeout: 30000 });
  // Commits persist on the Git page even after the epic clone is reclaimed.
  await expect(page.getByTestId('git-commits').first()).toBeVisible({ timeout: 30000 });
  await shot(page, 'git');
});

// ---------------------------------------------------------------- Notifications
test('notifications: activity produces notifications, badge + mark-all-read', async ({ page }) => {
  await createProject(page, 'Cov Notify');
  await addSpecialist(page, 'frontend-engineer');

  await nav(page, 'Threads');
  await page.getByTestId('chat-input').fill('Please build a small widget.');
  await page.getByTestId('chat-send').click();

  await nav(page, 'Notifications');
  await expect(page.getByTestId('notification-item').first()).toBeVisible({ timeout: 30000 });
  await shot(page, 'notifications');
  if (
    await page
      .getByTestId('mark-all-read')
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByTestId('mark-all-read').click();
  }
});

// ---------------------------------------------------------------- Activity
test('activity: grouped feed with agent filter', async ({ page }) => {
  await createProject(page, 'Cov Activity');
  await addSpecialist(page, 'frontend-engineer');

  await nav(page, 'Board');
  await page.getByTestId('add-workitem').click();
  await page.getByTestId('workitem-title').fill('Tidy the footer');
  await page.getByTestId('workitem-assignee').selectOption({ label: '🖥️ Frontend Engineer' });
  await page.getByTestId('workitem-submit').click();

  await nav(page, 'Activity');
  await expect(page.getByTestId('activity-log')).toContainText('Frontend Engineer', {
    timeout: 20000,
  });
  await shot(page, 'activity');
});

// ---------------------------------------------------------------- Settings
test('settings: manual-approval toggle + save', async ({ page }) => {
  await createProject(page, 'Cov Settings');
  await nav(page, 'Settings');
  await expect(page.getByTestId('approval-manual')).toBeVisible();
  await page.getByTestId('approval-manual').click();
  await page.getByTestId('settings-save').click();
  await shot(page, 'settings');
});

// ------------------------------------------- MAJOR-1: acceptance-probe epic gate
test('acceptance probe: deterministic epic gate runs and surfaces in the verification panel', async ({
  page,
}) => {
  await createProject(page, 'Cov Probe');

  // Set a deterministic passing acceptance probe via the API (the epic gate must
  // run it against the integrated tree before merge).
  const list = (await (await page.request.get('/api/projects')).json()) as {
    projects: Array<{ id: string; name: string }>;
  };
  const projectId = list.projects.find((p) => p.name === 'Cov Probe')!.id;
  await page.request.patch(`/api/projects/${projectId}`, {
    data: { acceptanceCommand: 'node -e "process.exit(0)"' },
  });

  await addSpecialist(page, 'frontend-engineer');
  await addSpecialist(page, 'qa-engineer');

  await nav(page, 'Threads');
  await page.getByTestId('chat-input').fill('Please build a greeting module.');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('lead-message').last()).toBeVisible({ timeout: 20000 });

  // Wait until the epic's merge-authority report (with the acceptance-probe check)
  // is recorded, then open the epic card detail and confirm it surfaces in the UI.
  await nav(page, 'Board');
  const epicCard = page.getByTestId('workitem').filter({ hasText: 'EPIC' }).first();
  await expect(epicCard).toBeVisible({ timeout: 20000 });

  await expect
    .poll(
      async () => {
        const body = (await (
          await page.request.get(`/api/projects/${projectId}/verification?limit=500`)
        ).json()) as {
          reports: Array<{ scope: string; checks: Array<{ id: string; status: string }> }>;
        };
        const epicReport = body.reports.find(
          (r) => r.scope === 'epic' && r.checks.some((c) => c.id === 'acceptance-probe'),
        );
        return epicReport?.checks.find((c) => c.id === 'acceptance-probe')?.status ?? 'none';
      },
      { timeout: 30000 },
    )
    .toBe('pass');

  await epicCard.getByTestId('workitem-title').click();
  await expect(page.getByTestId('workitem-detail')).toBeVisible();
  await expect(page.getByTestId('verification-panel')).toContainText('acceptance-probe');
  await shot(page, 'acceptance-probe');
});
